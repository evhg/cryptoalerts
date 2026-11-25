// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAToken {
    function balanceOf(address) external view returns (uint256);
}

interface IAStUsds is IAToken {
    function maxWithdraw(address owner) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface IADaiUsds {
    function daiToUsds(address usr, uint256 wad) external;
    function usdsToDai(address usr, uint256 wad) external;
}

interface IAFlash {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface IAPool {
    function add_liquidity(uint256[] calldata amounts, uint256 minMint) external returns (uint256);
    function remove_liquidity_one_coin(uint256 burn, int128 i, uint256 minOut) external returns (uint256);
    function calc_token_amount(uint256[] calldata amounts, bool deposit) external view returns (uint256);
    function calc_withdraw_one_coin(uint256 burn, int128 i) external view returns (uint256);
}

interface IAPsm {
    function buyGem(address usr, uint256 gemAmt) external returns (uint256);
}

interface IARouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
    function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory);
}

interface IAFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title StUsdsArbAuto
/// @notice The stUSDS arb with its size decided on-chain, at the moment it
///         runs: it looks at how much USDS Sky can pay out right now, buys
///         that much discounted stUSDS at the Curve pool, redeems it, pays the
///         block builder a share of the profit and sends the rest to one
///         fixed wallet.
///
/// Because it needs to know nothing in advance, the same transaction can sit
/// in every block and only goes through when liquidity is there. When there is
/// none it reverts, and a reverting bundle is not included and costs nothing.
///
/// Safety is the same as the other arb contracts, with less freedom:
///  - It holds nothing between transactions and nobody approves it. It trades
///    with flash-minted DAI that must be returned in the same transaction.
///  - Every address it calls is fixed in the code. The keeper supplies numbers
///    only (limits and the builder's share), never a destination or calldata.
///  - Profit can only go to `profitTo`, fixed at deployment.
///  - A run reverts unless at least `minNet` USDS reaches `profitTo`, unless
///    Sky pays out every share that was bought, and unless the tip conversion
///    gets at least 97% of the Chainlink ETH price.
///  - No upgrade path, no delegatecall.
contract StUsdsArbAuto {
    address public constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address public constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address public constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address public constant POOL = 0x2C7C98A3b1582D83c43987202aEFf638312478aE; // Curve stUSDS/USDS
    address public constant PSM = 0xA188EEC8F81263234dA3622A406892F3D630f98c; // Sky's USDS <-> USDC converter
    address public constant ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // Uniswap
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419; // Chainlink

    address public immutable profitTo;
    address public keeper;

    bool private active;

    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    uint256 private constant MAX_PRICE_AGE = 6 hours;
    uint256 private constant MAX_TIP_BPS = 9995;
    uint256 private constant MIN_TIP = 5e16; // below 0.05 USDS a tip is not worth converting

    event Arb(uint256 available, uint256 spent, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net);
    event KeeperSet(address keeper);

    error NotKeeper();
    error NotOwner();
    error Busy();
    error BadCallback();
    error BadTipShare();
    error TooLittle(uint256 available, uint256 minimum);
    error NoQuote();
    error ApproveFailed();
    error NotFullyRedeemable(uint256 shares, uint256 redeemable);
    error StalePrice();
    error BadTipRate(uint256 tipWei, uint256 spent);
    error Unprofitable(uint256 have, uint256 need);
    error NotActive();

    constructor(address profitTo_, address keeper_) {
        require(profitTo_ != address(0), "zero address");
        profitTo = profitTo_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// The wallet that receives the profit can replace the keeper.
    function setKeeper(address keeper_) external {
        if (msg.sender != profitTo) revert NotOwner();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// How much USDS Sky can pay out right now, as far as this contract can see it: the pool holds millions of
    /// stUSDS, so what the pool itself could withdraw is the vault's free liquidity (up to the pool's own holding).
    function available() public view returns (uint256) {
        return IAStUsds(ST_USDS).maxWithdraw(POOL);
    }

    /// Take whatever is withdrawable right now.
    /// @param minAvail  do nothing (revert) unless at least this much USDS is withdrawable
    /// @param maxSpend  never spend more than this much USDS on stUSDS
    /// @param tipBps    share of the profit paid to the block builder, in hundredths of a percent
    /// @param minNet    always keep at least this much USDS for `profitTo` (the tip shrinks to make room; revert if
    ///                  the whole profit is smaller)
    /// @param refineMin after the first purchase, top up if at least this much USDS of liquidity is still unused
    /// @return net      USDS that reached `profitTo`
    function run(uint256 minAvail, uint256 maxSpend, uint256 tipBps, uint256 minNet, uint256 refineMin)
        external
        returns (uint256 net)
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (active) revert Busy();
        if (tipBps > MAX_TIP_BPS) revert BadTipShare();

        Job memory j = _size(minAvail, maxSpend);
        j.tipBps = tipBps;
        j.minNet = minNet;
        j.refineMin = refineMin;

        active = true;
        uint256 before = IAToken(USDS).balanceOf(profitTo);
        // 2% more than the first purchase, as room for the top-up; what is not used is simply handed back.
        IAFlash(FLASH).flashLoan(address(this), DAI, j.spend + j.spend / 50, abi.encode(j));
        active = false;
        _sweep(USDS);
        _sweep(DAI);
        _sweep(ST_USDS);
        _sweepEth();
        net = IAToken(USDS).balanceOf(profitTo) - before;
    }

    /// Decide how much USDS to spend for what is withdrawable right now.
    function _size(uint256 minAvail, uint256 maxSpend) internal view returns (Job memory j) {
        j.avail = available();
        if (j.avail < minAvail || j.avail == 0) revert TooLittle(j.avail, minAvail);
        // Aim to redeem 99.9% of it, so that interest accruing by the second cannot leave a share unredeemable.
        j.target = j.avail * 9990 / 10000;
        j.nav = IAStUsds(ST_USDS).convertToAssets(1e18);
        // stUSDS sells below what it redeems for, so start under the target and correct with the pool's own estimate.
        uint256 spend = j.target * 90 / 100;
        for (uint256 i = 0; i < 2; i++) {
            uint256 est = _estimate(spend);
            if (est == 0) revert NoQuote();
            spend = spend * j.target / (est * j.nav / 1e18);
        }
        // The pool's estimate can be off by a quarter of a percent; stay under it. The top-up recovers the rest.
        spend = spend * 996 / 1000;
        if (spend > maxSpend) spend = maxSpend;
        if (spend == 0) revert NoQuote();
        j.spend = spend;
    }

    /// Sends whatever this contract holds of a token to `profitTo`. Open to anyone: it can only help.
    function sweep(address token) external {
        if (active) revert Busy();
        _sweep(token);
        _sweepEth();
    }

    struct Job {
        uint256 avail;
        uint256 spend;
        uint256 target;
        uint256 nav;
        uint256 tipBps;
        uint256 minNet;
        uint256 refineMin;
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (msg.sender != FLASH || initiator != address(this) || token != DAI || fee != 0 || !active) {
            revert BadCallback();
        }
        Job memory j = abi.decode(data, (Job));

        _approve(DAI, DAI_USDS, amount);
        IADaiUsds(DAI_USDS).daiToUsds(address(this), amount);

        _settle(j, amount, _acquire(j, amount));
        return CALLBACK_SUCCESS;
    }

    /// Redeem, tip the builder, repay the flash loan and send what is left to `profitTo`.
    function _settle(Job memory j, uint256 amount, uint256 shares) internal {
        uint256 redeemable = IAStUsds(ST_USDS).maxRedeem(address(this));
        if (shares > redeemable) revert NotFullyRedeemable(shares, redeemable);
        uint256 redeemed = IAStUsds(ST_USDS).redeem(shares, address(this), address(this));

        uint256 have = IAToken(USDS).balanceOf(address(this));
        if (have <= amount || have - amount < j.minNet) revert Unprofitable(have, amount + j.minNet);
        // The builder gets its share of the profit, but never so much that less than `minNet` would be left.
        uint256 tipUsds = (have - amount) * j.tipBps / 10000;
        if (have - amount - tipUsds < j.minNet) tipUsds = have - amount - j.minNet;
        uint256 tipWei = _tip(tipUsds);

        have = IAToken(USDS).balanceOf(address(this));
        if (have < amount + j.minNet) revert Unprofitable(have, amount + j.minNet);
        _approve(USDS, DAI_USDS, amount);
        IADaiUsds(DAI_USDS).usdsToDai(address(this), amount);
        _approve(DAI, FLASH, amount); // DssFlash pulls the DAI back after this returns
        _transfer(USDS, profitTo, have - amount);
        emit Arb(j.avail, j.spend, shares, redeemed, tipWei, have - amount);
    }

    /// The purchase, and one top-up when the first buy left liquidity unused. Records what was spent in `j.spend`.
    function _acquire(Job memory j, uint256 budget) internal returns (uint256 shares) {
        shares = _buy(j.spend);
        uint256 value = shares * j.nav / 1e18;
        if (value < j.target && j.target - value >= j.refineMin) {
            // Buy the unused remainder at the price just paid, within the flash loan's spare room.
            uint256 more = (j.target - value) * j.spend / value;
            if (more > budget - j.spend) more = budget - j.spend;
            if (more > 0) {
                shares += _buy(more);
                j.spend += more;
            }
        }
    }

    receive() external payable {
        if (!active) revert NotActive();
    }

    /// stUSDS for USDS through the pool's add-liquidity / remove-one-coin path (cheaper than a swap in a lopsided pool).
    function _buy(uint256 usdsIn) internal returns (uint256 shares) {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdsIn;
        _approve(USDS, POOL, usdsIn);
        uint256 lp = IAPool(POOL).add_liquidity(amounts, 0);
        _approve(USDS, POOL, 0);
        uint256 beforeShares = IAToken(ST_USDS).balanceOf(address(this));
        IAPool(POOL).remove_liquidity_one_coin(lp, 1, 0);
        shares = IAToken(ST_USDS).balanceOf(address(this)) - beforeShares;
    }

    function _estimate(uint256 usdsIn) internal view returns (uint256) {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = usdsIn;
        return IAPool(POOL).calc_withdraw_one_coin(IAPool(POOL).calc_token_amount(amounts, true), 1);
    }

    /// Converts `tipUsds` of the profit to ETH (USDS -> USDC at Sky's converter, USDC -> ETH on Uniswap) and pays it
    /// to the block builder. Returns the wei paid.
    function _tip(uint256 tipUsds) internal returns (uint256 tipWei) {
        uint256 gem = tipUsds / 1e12; // USDC has 6 decimals
        if (gem * 1e12 < MIN_TIP) return 0;
        uint256 spent = gem * 1e12;
        _approve(USDS, PSM, spent);
        IAPsm(PSM).buyGem(address(this), gem);
        _approve(USDS, PSM, 0);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            IARouter.exactInputSingle, (IARouter.ExactInputSingleParams(USDC, WETH, 500, address(2), gem, 0, 0))
        );
        calls[1] = abi.encodeCall(IARouter.unwrapWETH9, (0, address(this)));
        uint256 ethBefore = address(this).balance;
        _approve(USDC, ROUTER, gem);
        IARouter(ROUTER).multicall(calls);
        _approve(USDC, ROUTER, 0);
        tipWei = address(this).balance - ethBefore;

        (, int256 answer,, uint256 updatedAt,) = IAFeed(ETH_USD).latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        if (tipWei * (uint256(answer) * 1e10) / 1e18 < spent * 97 / 100) revert BadTipRate(tipWei, spent);

        address builder = block.coinbase;
        bool paid;
        assembly ("memory-safe") {
            paid := call(60000, builder, tipWei, 0, 0, 0, 0)
        }
        if (!paid) tipWei = 0; // stays here and is swept to profitTo
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _sweep(address token) internal {
        uint256 b = IAToken(token).balanceOf(address(this));
        if (b > 0) _transfer(token, profitTo, b);
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
