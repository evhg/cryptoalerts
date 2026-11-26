// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ILToken {
    function balanceOf(address) external view returns (uint256);
}

interface ILStUsds is ILToken {
    function maxRedeem(address owner) external view returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface ILMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface ILDaiUsds {
    function daiToUsds(address usr, uint256 wad) external;
    function usdsToDai(address usr, uint256 wad) external;
}

interface ILFlash {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface ILPool {
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function add_liquidity(uint256[] calldata amounts, uint256 minMint) external returns (uint256);
    function remove_liquidity_one_coin(uint256 burn, int128 i, uint256 minOut) external returns (uint256);
    function calc_token_amount(uint256[] calldata amounts, bool deposit) external view returns (uint256);
    function calc_withdraw_one_coin(uint256 burn, int128 i) external view returns (uint256);
}

interface ILPsm {
    function buyGem(address usr, uint256 gemAmt) external returns (uint256);
}

interface ILRouter {
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

interface ILFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title StUsdsArbLite
/// @notice The stUSDS arb, built to use as little gas as possible. Block
///         builders rank competing transactions by what they pay per unit of
///         gas, so a lean transaction wins against a heavier one that offers
///         the same share of the same profit.
///
/// It looks at how much stUSDS Sky can redeem right now, buys that much at
/// the Curve pool with borrowed USDS, redeems it, repays, and sends the
/// profit to one fixed wallet. Like the earlier version it needs to know
/// nothing in advance, so the same transaction can sit in every block; with
/// nothing redeemable it reverts, and a reverting bundle is not included.
///
/// What makes it lean:
///  - It borrows USDS directly (a free flash loan from Morpho) instead of
///    minting DAI and converting both ways. The DAI route remains as the
///    fallback for sizes Morpho cannot lend.
///  - It pays the block builder out of ETH this contract already holds, at an
///    ETH price the keeper supplies, instead of swapping part of the profit
///    to ETH inside the transaction. Only when the ETH held is not enough for
///    a large tip is the remainder swapped, checked against Chainlink.
///  - One swap at the pool for small sizes; the cheaper-priced two-step route
///    only above a size the keeper sets.
///  - For small sizes the keeper passes the pool price it last saw, which
///    saves asking the pool inside the transaction.
///
/// Safety:
///  - Every address it calls is fixed in the code. The keeper supplies numbers
///    only, never a destination or calldata.
///  - The USDS profit can only go to `profitTo`. The ETH it holds can only go
///    to the block builder as a tip for a profitable run, or to `profitTo`.
///  - A tip is always a share of profit actually made in the same
///    transaction, priced at no more than `MAX_WEI_PER_USDS`.
///  - Nobody approves this contract, and it holds no tokens between
///    transactions. No upgrade path, no delegatecall.
contract StUsdsArbLite {
    address public constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address public constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address public constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address public constant POOL = 0x2C7C98A3b1582D83c43987202aEFf638312478aE; // Curve stUSDS/USDS
    address public constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address public constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address public constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address public constant PSM = 0xA188EEC8F81263234dA3622A406892F3D630f98c; // Sky's USDS <-> USDC converter
    address public constant ROUTER = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45; // Uniswap
    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419; // Chainlink

    /// The keeper's ETH price can never value one USDS above this (ETH at $500).
    uint256 public constant MAX_WEI_PER_USDS = 2e15;
    uint256 private constant MAX_TIP_BPS = 9995;
    /// A tip the held ETH cannot cover is only swapped for inside the transaction when at least this much is missing.
    uint256 private constant CONVERT_MIN = 10e18;
    uint256 private constant MAX_PRICE_AGE = 6 hours;
    bytes32 private constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    address public immutable profitTo;
    address public keeper;

    bool private transient active;
    uint256 private transient lastNet;

    event Arb(uint256 available, uint256 spent, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net);
    event KeeperSet(address keeper);

    error NotKeeper();
    error NotOwner();
    error Busy();
    error BadCallback();
    error BadTipShare();
    error BadRate();
    error TooLittle(uint256 redeemable, uint256 minimum);
    error NoQuote();
    error ApproveFailed();
    error StalePrice();
    error BadTipRate(uint256 tipWei, uint256 spent);
    error Unprofitable(uint256 redeemed, uint256 need);

    struct Job {
        uint256 avail; // shares Sky can redeem right now
        uint256 spend; // USDS to spend at the pool
        uint256 tipBps;
        uint256 weiPerUsds;
        uint256 minNet;
        bool twoStep;
    }

    constructor(address profitTo_, address keeper_) {
        require(profitTo_ != address(0), "zero address");
        profitTo = profitTo_;
        keeper = keeper_;
        emit KeeperSet(keeper_);
        // Standing approvals to the fixed venues. This contract holds no tokens between transactions, so there is
        // never anything for an approval to reach; setting them once saves two approvals in every run.
        _approve(USDS, POOL);
        _approve(USDS, MORPHO);
        _approve(USDS, DAI_USDS);
        _approve(DAI, DAI_USDS);
        _approve(DAI, FLASH);
        _approve(USDS, PSM);
        _approve(USDC, ROUTER);
    }

    /// The wallet that receives the profit can replace the keeper.
    function setKeeper(address keeper_) external {
        if (msg.sender != profitTo) revert NotOwner();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// Shares Sky can redeem right now, as far as this contract can see it: the pool holds over a million stUSDS,
    /// so what the pool itself could redeem is the vault's free liquidity (up to the pool's own holding).
    function available() public view returns (uint256) {
        return ILStUsds(ST_USDS).maxRedeem(POOL);
    }

    /// Take whatever is redeemable right now.
    /// @param minShares   do nothing (revert) unless at least this many stUSDS are redeemable
    /// @param maxSpend    never spend more than this much USDS on stUSDS
    /// @param tipBps      share of the profit paid to the block builder, in hundredths of a percent
    /// @param weiPerUsds  the ETH price used to turn that share into a tip (wei per 1 USDS)
    /// @param minNet      always keep at least this much USDS of profit after the tip's value (the tip shrinks to
    ///                    make room; revert if the whole profit is smaller)
    /// @param twoStepFrom from this much USDS, buy through the pool's add/remove route (better price, more gas)
    /// @param price       USDS to spend per redeemable share (1e18 = 1 USDS), as the keeper last saw it at the pool;
    ///                    saves asking the pool. Zero, or a size on the two-step route, asks the pool instead.
    ///                    Too high a price buys more than Sky can redeem and the run reverts; too low leaves some.
    /// @return net        USDS that reached `profitTo`
    function run(
        uint256 minShares,
        uint256 maxSpend,
        uint256 tipBps,
        uint256 weiPerUsds,
        uint256 minNet,
        uint256 twoStepFrom,
        uint256 price
    ) external returns (uint256 net) {
        if (msg.sender != keeper) revert NotKeeper();
        if (active) revert Busy();
        if (tipBps > MAX_TIP_BPS) revert BadTipShare();
        if (weiPerUsds > MAX_WEI_PER_USDS) revert BadRate();

        Job memory j;
        j.avail = available();
        if (j.avail < minShares || j.avail == 0) revert TooLittle(j.avail, minShares);
        j.tipBps = tipBps;
        j.weiPerUsds = weiPerUsds;
        j.minNet = minNet;
        // A first guess well under the target (a share costs about 1 USDS at the pool), then scaled up with the
        // pool's own quote. Scaling up can only undershoot, because every extra USDS buys a little less.
        uint256 probe = j.avail * 85 / 100;
        if (probe > maxSpend) probe = maxSpend;
        j.twoStep = probe >= twoStepFrom;
        if (price != 0 && !j.twoStep) {
            j.spend = j.avail * price / 1e18;
        } else {
            j.spend = _scale(probe, j.avail, j.twoStep);
            if (j.twoStep) j.spend = _scale(j.spend, j.avail, true); // large sizes: once more, from closer
        }
        if (j.spend > maxSpend) j.spend = maxSpend;
        if (j.spend == 0) revert NoQuote();

        active = true;
        bytes memory data = abi.encode(j);
        if (ILToken(USDS).balanceOf(MORPHO) >= j.spend) {
            ILMorpho(MORPHO).flashLoan(USDS, j.spend, data);
        } else {
            ILFlash(FLASH).flashLoan(address(this), DAI, j.spend, data);
        }
        active = false;
        net = lastNet;
    }

    /// USDS to spend so that the shares bought come to just under `target`, judged from a quote at `probe`.
    function _scale(uint256 probe, uint256 target, bool twoStep) internal view returns (uint256) {
        uint256 est;
        if (twoStep) {
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = probe;
            est = ILPool(POOL).calc_withdraw_one_coin(ILPool(POOL).calc_token_amount(amounts, true), 1);
            // This estimate can run a quarter of a percent high; stay under it.
            est = est * 1004 / 1000;
        } else {
            est = ILPool(POOL).get_dy(0, 1, probe);
        }
        if (est == 0) revert NoQuote();
        return probe * target / est * 9995 / 10000;
    }

    /// Morpho's flash loan callback: the USDS is here, and Morpho takes it back when this returns.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != MORPHO || !active) revert BadCallback();
        Job memory j = abi.decode(data, (Job));
        if (assets != j.spend) revert BadCallback();
        _work(j);
    }

    /// The fallback: flash-minted DAI, converted to USDS and back.
    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (msg.sender != FLASH || initiator != address(this) || token != DAI || fee != 0 || !active) {
            revert BadCallback();
        }
        Job memory j = abi.decode(data, (Job));
        if (amount != j.spend) revert BadCallback();
        ILDaiUsds(DAI_USDS).daiToUsds(address(this), amount);
        _work(j);
        ILDaiUsds(DAI_USDS).usdsToDai(address(this), amount); // DssFlash pulls the DAI back after this returns
        return CALLBACK_SUCCESS;
    }

    /// Buy, redeem, tip the builder and send the profit on. Leaves exactly `j.spend` USDS here for the lender.
    function _work(Job memory j) internal {
        uint256 shares;
        if (j.twoStep) {
            uint256[] memory amounts = new uint256[](2);
            amounts[0] = j.spend;
            shares = ILPool(POOL).remove_liquidity_one_coin(ILPool(POOL).add_liquidity(amounts, 0), 1, 0);
        } else {
            shares = ILPool(POOL).exchange(0, 1, j.spend, 0);
        }
        // Reverts by itself if Sky cannot pay out every share that was bought.
        uint256 redeemed = ILStUsds(ST_USDS).redeem(shares, address(this), address(this));
        if (redeemed < j.spend + j.minNet || redeemed == j.spend) revert Unprofitable(redeemed, j.spend + j.minNet);
        uint256 profit = redeemed - j.spend;

        // The builder gets its share of the profit, but never so much that less than `minNet` would be left.
        uint256 tipUsds = profit * j.tipBps / 10000;
        if (profit - tipUsds < j.minNet) tipUsds = profit - j.minNet;
        (uint256 tipWei, uint256 swapped) = _tip(tipUsds, j.weiPerUsds);

        uint256 net = profit - swapped;
        _transfer(USDS, profitTo, net);
        lastNet = net;
        emit Arb(j.avail * redeemed / shares, j.spend, shares, redeemed, tipWei, net);
    }

    /// Pays the builder `tipUsds` worth of ETH: from the ETH held here, and when that is not enough for a large tip,
    /// by swapping the missing part of the profit (USDS -> USDC at Sky's converter, USDC -> ETH on Uniswap).
    /// Returns the wei paid and the USDS of profit that was swapped.
    function _tip(uint256 tipUsds, uint256 weiPerUsds) internal returns (uint256 tipWei, uint256 swapped) {
        uint256 want = tipUsds * weiPerUsds / 1e18;
        if (want == 0) return (0, 0);
        uint256 held = address(this).balance;
        tipWei = want;
        if (want > held) {
            tipWei = held;
            uint256 gem = (want - held) * 1e18 / weiPerUsds / 1e12; // USDC has 6 decimals
            if (gem * 1e12 >= CONVERT_MIN) {
                swapped = gem * 1e12;
                tipWei += _swapToEth(gem, swapped);
            }
        }
        if (tipWei == 0) return (0, swapped);
        address builder = block.coinbase;
        bool paid;
        assembly ("memory-safe") {
            paid := call(60000, builder, tipWei, 0, 0, 0, 0)
        }
        if (!paid) tipWei = 0; // the ETH simply stays here
    }

    function _swapToEth(uint256 gem, uint256 spent) internal returns (uint256 got) {
        ILPsm(PSM).buyGem(address(this), gem);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            ILRouter.exactInputSingle,
            (ILRouter.ExactInputSingleParams(USDC, 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2, 500, address(2), gem, 0, 0))
        );
        calls[1] = abi.encodeCall(ILRouter.unwrapWETH9, (0, address(this)));
        uint256 ethBefore = address(this).balance;
        ILRouter(ROUTER).multicall(calls);
        got = address(this).balance - ethBefore;
        (, int256 answer,, uint256 updatedAt,) = ILFeed(ETH_USD).latestRoundData();
        if (answer <= 0 || block.timestamp - updatedAt > MAX_PRICE_AGE) revert StalePrice();
        if (got * (uint256(answer) * 1e10) / 1e18 < spent * 97 / 100) revert BadTipRate(got, spent);
    }

    /// ETH sent here is the tip money.
    receive() external payable {}

    /// Returns tip money to `profitTo`. Only that wallet or the keeper can ask, so nobody else can empty it.
    function withdrawEth(uint256 amount) external {
        if (msg.sender != profitTo && msg.sender != keeper) revert NotOwner();
        if (active) revert Busy();
        address to = profitTo;
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        require(ok, "withdraw failed");
    }

    /// Sends whatever this contract holds of a token to `profitTo`. Open to anyone: it can only help.
    function sweep(address token) external {
        if (active) revert Busy();
        uint256 b = ILToken(token).balanceOf(address(this));
        if (b > 0) _transfer(token, profitTo, b);
    }

    function _approve(address token, address spender) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, type(uint256).max));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }
}
