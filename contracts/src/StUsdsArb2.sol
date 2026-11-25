// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Like2 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsLike2 is IERC20Like2 {
    function maxRedeem(address owner) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface IDaiUsdsLike2 {
    function daiToUsds(address usr, uint256 wad) external;
    function usdsToDai(address usr, uint256 wad) external;
}

interface IDssFlashLike2 {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface IAggregatorLike2 {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title StUsdsArb2
/// @notice Second version of the stUSDS arb: buys stUSDS below its redemption
///         value directly at trading venues, redeems it at Sky in the same
///         transaction and sends the profit to one fixed wallet.
///
/// What changed from StUsdsArb: the purchase and the tip conversion are lists
/// of calls to venues (Curve pool, Uniswap router, Sky's USDC converter, the
/// KyberSwap router) instead of one opaque KyberSwap call, so the bot can build
/// them from on-chain prices alone, without waiting for an outside API.
///
/// What did not change, and is what makes it safe:
///  - It holds nothing between transactions and nobody approves it. The money
///    it trades with is flash-minted DAI that must be returned in the same
///    transaction, so a bad plan can only revert.
///  - Profit can only go to `profitTo`, fixed at deployment. Leftovers of any
///    token are swept there too.
///  - Only the keeper can start a run. Calls go only to the venues fixed at
///    deployment; there is no way to add one later.
///  - A run reverts unless at least `minNet` USDS reaches `profitTo`, unless
///    Sky pays out every share that was bought, and unless the tip conversion
///    gets at least 97% of the Chainlink ETH price.
///  - No upgrade path, no delegatecall.
contract StUsdsArb2 {
    IERC20Like2 public immutable dai;
    IERC20Like2 public immutable usds;
    IStUsdsLike2 public immutable stUsds;
    IDaiUsdsLike2 public immutable daiUsds;
    IDssFlashLike2 public immutable flash;
    IAggregatorLike2 public immutable ethUsd;
    address public immutable profitTo;

    /// Contracts a run may call. Written once, in the constructor.
    mapping(address => bool) public venue;
    address public keeper;

    bool private active;

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    uint256 private constant MAX_PRICE_AGE = 6 hours;
    uint256 private constant NONE = type(uint256).max;

    /// One call to a venue.
    struct Step {
        address target; // must be a venue
        address token; // token the venue takes from this contract (zero = none)
        uint256 amount; // how much of it the venue may take; max uint = all this contract holds
        uint256 patch; // byte offset in `data` where that amount is written; max uint = nowhere
        bytes data;
    }

    struct Plan {
        uint256 flash; // DAI to flash-mint
        Step[] buy; // USDS -> stUSDS
        uint256 tipUsds; // most USDS the tip conversion may use (0 = no tip)
        Step[] tip; // USDS -> ETH, paid to the block builder
        uint256 minNet; // revert unless at least this much USDS reaches profitTo
    }

    event Arb(uint256 flash, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net);
    event KeeperSet(address keeper);

    error NotKeeper();
    error NotOwner();
    error Busy();
    error BadCallback();
    error NotVenue(address target);
    error BadPatch();
    error ApproveFailed();
    error NothingBought();
    error NotFullyRedeemable(uint256 shares, uint256 redeemable);
    error StalePrice();
    error TipOverspent(uint256 spent, uint256 allowed);
    error BadTipRate(uint256 tipWei, uint256 spent);
    error Unprofitable(uint256 have, uint256 need);
    error NotActive();

    constructor(
        address dai_,
        address usds_,
        address stUsds_,
        address daiUsds_,
        address flash_,
        address ethUsd_,
        address profitTo_,
        address keeper_,
        address[] memory venues_
    ) {
        require(
            dai_ != address(0) && usds_ != address(0) && stUsds_ != address(0) && daiUsds_ != address(0)
                && flash_ != address(0) && ethUsd_ != address(0) && profitTo_ != address(0),
            "zero address"
        );
        dai = IERC20Like2(dai_);
        usds = IERC20Like2(usds_);
        stUsds = IStUsdsLike2(stUsds_);
        daiUsds = IDaiUsdsLike2(daiUsds_);
        flash = IDssFlashLike2(flash_);
        ethUsd = IAggregatorLike2(ethUsd_);
        profitTo = profitTo_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
        for (uint256 i = 0; i < venues_.length; i++) {
            address v = venues_[i];
            // A venue is a place to trade, never one of the tokens or Sky contracts this run settles with.
            require(
                v != address(0) && v != dai_ && v != usds_ && v != stUsds_ && v != daiUsds_ && v != flash_
                    && v != profitTo_ && v.code.length > 0,
                "bad venue"
            );
            venue[v] = true;
        }
    }

    /// The wallet that receives the profit can replace the keeper.
    function setKeeper(address keeper_) external {
        if (msg.sender != profitTo) revert NotOwner();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Run one arb. Returns the USDS that reached `profitTo`.
    function arb(Plan calldata p) external returns (uint256 net) {
        if (msg.sender != keeper) revert NotKeeper();
        if (active) revert Busy();
        active = true;
        uint256 before = usds.balanceOf(profitTo);
        flash.flashLoan(address(this), address(dai), p.flash, abi.encode(p));
        active = false;
        _sweep(address(usds));
        _sweep(address(dai));
        _sweep(address(stUsds));
        _sweepEth();
        net = usds.balanceOf(profitTo) - before;
    }

    /// Sends whatever this contract holds of a token to `profitTo`. Open to anyone: it can only help.
    function sweep(address token) external {
        if (active) revert Busy();
        _sweep(token);
        _sweepEth();
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (msg.sender != address(flash) || initiator != address(this) || token != address(dai) || fee != 0 || !active)
        {
            revert BadCallback();
        }
        Plan memory p = abi.decode(data, (Plan));

        _approve(address(dai), address(daiUsds), amount);
        daiUsds.daiToUsds(address(this), amount);

        uint256 sharesBefore = stUsds.balanceOf(address(this));
        _run(p.buy);
        uint256 shares = stUsds.balanceOf(address(this)) - sharesBefore;
        if (shares == 0) revert NothingBought();

        uint256 redeemable = stUsds.maxRedeem(address(this));
        if (shares > redeemable) revert NotFullyRedeemable(shares, redeemable);
        uint256 redeemed = stUsds.redeem(shares, address(this), address(this));

        uint256 tipWei;
        if (p.tip.length > 0) {
            uint256 usdsBefore = usds.balanceOf(address(this));
            uint256 ethBefore = address(this).balance;
            _run(p.tip);
            uint256 usdsAfter = usds.balanceOf(address(this));
            uint256 spent = usdsBefore > usdsAfter ? usdsBefore - usdsAfter : 0;
            if (spent > p.tipUsds) revert TipOverspent(spent, p.tipUsds);
            tipWei = address(this).balance - ethBefore;
            if (tipWei * _ethPrice() / 1e18 < spent * 97 / 100) revert BadTipRate(tipWei, spent);
            address builder = block.coinbase;
            bool paid;
            assembly ("memory-safe") {
                paid := call(60000, builder, tipWei, 0, 0, 0, 0)
            }
            if (!paid) tipWei = 0; // stays here and is swept to profitTo
        }

        uint256 have = usds.balanceOf(address(this));
        if (have < amount + p.minNet) revert Unprofitable(have, amount + p.minNet);
        _approve(address(usds), address(daiUsds), amount);
        daiUsds.usdsToDai(address(this), amount);
        _approve(address(dai), address(flash), amount); // DssFlash pulls the DAI back after this returns
        uint256 net = have - amount;
        require(usds.transfer(profitTo, net), "transfer failed");
        emit Arb(amount, shares, redeemed, tipWei, net);
        return CALLBACK_SUCCESS;
    }

    receive() external payable {
        if (!active) revert NotActive();
    }

    function _run(Step[] memory steps) internal {
        for (uint256 i = 0; i < steps.length; i++) {
            Step memory s = steps[i];
            if (!venue[s.target]) revert NotVenue(s.target);
            bytes memory data = s.data;
            if (s.token != address(0)) {
                uint256 amt = s.amount == NONE ? IERC20Like2(s.token).balanceOf(address(this)) : s.amount;
                if (s.patch != NONE) {
                    if (s.patch > data.length || data.length - s.patch < 32) revert BadPatch();
                    uint256 at = s.patch;
                    assembly ("memory-safe") {
                        mstore(add(add(data, 32), at), amt)
                    }
                }
                _approve(s.token, s.target, amt);
            }
            (bool ok, bytes memory ret) = s.target.call(data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
            if (s.token != address(0)) _approve(s.token, s.target, 0);
        }
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    function _ethPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsd.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        return uint256(answer) * 1e10; // 8 -> 18 decimals
    }

    function _sweep(address token) internal {
        uint256 b = IERC20Like2(token).balanceOf(address(this));
        if (b > 0) {
            (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, profitTo, b));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "sweep failed");
        }
    }

    function _sweepEth() internal {
        uint256 b = address(this).balance;
        if (b > 0) {
            address to = profitTo;
            bool ok;
            assembly ("memory-safe") {
                ok := call(gas(), to, b, 0, 0, 0, 0)
            }
            require(ok, "sweep failed");
        }
    }
}
