// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsLike is IERC20Like {
    function maxRedeem(address owner) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface IDaiUsdsLike {
    function daiToUsds(address usr, uint256 wad) external;
    function usdsToDai(address usr, uint256 wad) external;
}

interface IDssFlashLike {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface IAggregatorLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title StUsdsArb
/// @notice Buys stUSDS below its redemption value and redeems it at Sky in the
///         same transaction, with money flash-minted for that transaction only.
///         The profit goes to one fixed wallet.
///
/// Trust model, by construction:
///  - Uses no money of its own and none of the owner's: it never has, and never
///    asks for, an approval on anyone's tokens. The working capital is DAI
///    flash-minted by Sky's DssFlash and must be repaid before the transaction
///    ends, or the whole transaction reverts.
///  - The profit recipient is immutable. No parameter can name another one.
///  - The only outside contract it ever hands tokens to is one fixed DEX router,
///    with an approval for the exact amount, reset to zero right after. Whatever
///    the router does, the transaction reverts unless every bought share was
///    redeemed, the flash loan is repaid and at least `minNet` USDS is left.
///  - Holds nothing between transactions: anything left (including donations)
///    is swept to the profit recipient at the end of each run.
contract StUsdsArb {
    IERC20Like public immutable dai;
    IERC20Like public immutable usds;
    IStUsdsLike public immutable stUsds;
    IDaiUsdsLike public immutable daiUsds;
    IDssFlashLike public immutable flash;
    address public immutable router;
    IAggregatorLike public immutable ethUsd;
    /// Receives every profit. Also the only account that can change the keeper.
    address public immutable profitTo;

    /// Account allowed to start a run.
    address public keeper;

    bool private active;

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    uint256 private constant MAX_PRICE_AGE = 6 hours;

    struct Plan {
        uint256 flash; // DAI to flash-mint, all of it spent buying stUSDS
        bytes buyData; // router calldata: `flash` USDS -> stUSDS, recipient this contract
        uint256 tipUsds; // USDS converted to ETH for the block builder (0 = no tip)
        bytes tipData; // router calldata: `tipUsds` USDS -> ETH, recipient this contract
        uint256 minNet; // revert unless at least this much USDS reaches profitTo
    }

    event Arb(uint256 flash, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net);
    event KeeperSet(address keeper);

    error NotKeeper();
    error NotOwner();
    error Busy();
    error BadCallback();
    error RouterFailed();
    error NothingBought();
    error NotFullyRedeemable(uint256 shares, uint256 redeemable);
    error StalePrice();
    error BadTipRate(uint256 tipWei, uint256 tipUsds);
    error Unprofitable(uint256 have, uint256 need);
    error NotActive();

    constructor(
        address dai_,
        address usds_,
        address stUsds_,
        address daiUsds_,
        address flash_,
        address router_,
        address ethUsd_,
        address profitTo_,
        address keeper_
    ) {
        require(
            dai_ != address(0) && usds_ != address(0) && stUsds_ != address(0) && daiUsds_ != address(0)
                && flash_ != address(0) && router_ != address(0) && ethUsd_ != address(0) && profitTo_ != address(0),
            "zero address"
        );
        dai = IERC20Like(dai_);
        usds = IERC20Like(usds_);
        stUsds = IStUsdsLike(stUsds_);
        daiUsds = IDaiUsdsLike(daiUsds_);
        flash = IDssFlashLike(flash_);
        router = router_;
        ethUsd = IAggregatorLike(ethUsd_);
        profitTo = profitTo_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != profitTo) revert NotOwner();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Run one arbitrage. Reverts (costing only gas, and nothing at all
    ///         when sent as a bundle) unless it ends in profit.
    function arb(Plan calldata p) external returns (uint256 net) {
        if (msg.sender != keeper) revert NotKeeper();
        if (active) revert Busy();
        active = true;
        uint256 before = usds.balanceOf(profitTo);
        flash.flashLoan(address(this), address(dai), p.flash, abi.encode(p));
        active = false;
        _sweep();
        net = usds.balanceOf(profitTo) - before;
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

        // 1. Flash-minted DAI -> USDS, 1:1 through Sky's converter.
        dai.approve(address(daiUsds), amount);
        daiUsds.daiToUsds(address(this), amount);

        // 2. Buy stUSDS with exactly that USDS.
        uint256 sharesBefore = stUsds.balanceOf(address(this));
        _route(usds, amount, p.buyData);
        uint256 shares = stUsds.balanceOf(address(this)) - sharesBefore;
        if (shares == 0) revert NothingBought();

        // 3. Redeem every bought share at Sky. Never keep stUSDS: if Sky cannot
        //    pay all of it out right now, the whole transaction reverts.
        uint256 redeemable = stUsds.maxRedeem(address(this));
        if (shares > redeemable) revert NotFullyRedeemable(shares, redeemable);
        uint256 redeemed = stUsds.redeem(shares, address(this), address(this));

        // 4. Optional tip to the block builder, paid out of the profit.
        uint256 tipWei;
        if (p.tipUsds > 0) {
            uint256 ethBefore = address(this).balance;
            _route(usds, p.tipUsds, p.tipData);
            tipWei = address(this).balance - ethBefore;
            // The conversion must be worth at least 97% of the oracle price.
            if (tipWei * _ethPrice() / 1e18 < p.tipUsds * 97 / 100) revert BadTipRate(tipWei, p.tipUsds);
            address builder = block.coinbase;
            bool paid;
            assembly ("memory-safe") {
                paid := call(60000, builder, tipWei, 0, 0, 0, 0)
            }
            // A builder that cannot take the tip forgoes it; the ETH is swept to profitTo.
            if (!paid) tipWei = 0;
        }

        // 5. Repay and pay out. All of it must add up, or nothing happened.
        uint256 have = usds.balanceOf(address(this));
        if (have < amount + p.minNet) revert Unprofitable(have, amount + p.minNet);
        usds.approve(address(daiUsds), amount);
        daiUsds.usdsToDai(address(this), amount);
        dai.approve(address(flash), amount); // DssFlash pulls the DAI back after this returns
        uint256 net = have - amount;
        require(usds.transfer(profitTo, net), "transfer failed");
        emit Arb(amount, shares, redeemed, tipWei, net);
        return CALLBACK_SUCCESS;
    }

    /// Router ETH only arrives in the middle of a run.
    receive() external payable {
        if (!active) revert NotActive();
    }

    function _route(IERC20Like token, uint256 amount, bytes memory data) internal {
        token.approve(router, amount);
        (bool ok,) = router.call(data);
        if (!ok) revert RouterFailed();
        token.approve(router, 0);
    }

    function _ethPrice() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsd.latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        return uint256(answer) * 1e10; // 8 -> 18 decimals
    }

    /// Anything left behind goes to profitTo, so this contract never holds value.
    function _sweep() internal {
        uint256 b = usds.balanceOf(address(this));
        if (b > 0) require(usds.transfer(profitTo, b), "sweep failed");
        b = dai.balanceOf(address(this));
        if (b > 0) require(dai.transfer(profitTo, b), "sweep failed");
        b = stUsds.balanceOf(address(this));
        if (b > 0) require(stUsds.transfer(profitTo, b), "sweep failed");
        b = address(this).balance;
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
