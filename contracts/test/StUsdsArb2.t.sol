// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {StUsdsArb2} from "../src/StUsdsArb2.sol";
import {StUsdsExit} from "../src/StUsdsExit.sol";
import {StUsdsQuoter} from "../src/StUsdsQuoter.sol";

interface IToken2 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsT2 is IToken2 {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
}

interface ICurve {
    function add_liquidity(uint256[] calldata amounts, uint256 minMint) external returns (uint256);
    function remove_liquidity_one_coin(uint256 burn, int128 i, uint256 minOut) external returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

interface IPsm {
    function buyGem(address usr, uint256 gemAmt) external returns (uint256);
}

interface IRouter02 {
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

interface IFlash2 {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

/// Fork tests of the direct-routing arb against real mainnet contracts:
/// the Curve stUSDS/USDS pool, Sky's USDC converter and Uniswap's router.
contract StUsdsArb2Test is Test {
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    address constant MAIN = 0xCD532243888D26791881064E24D4A25FD0041d98;
    address constant MAIN_EXIT = 0xbF54F2AA78b4c240e34224073aff9E89Cd915897;
    address constant BOT_KEY = 0x3C865A8F373544A6Abce380d68A4dEd7f8179BC9;
    address constant CURVE = 0x2C7C98A3b1582D83c43987202aEFf638312478aE;
    address constant PSM = 0xA188EEC8F81263234dA3622A406892F3D630f98c;
    address constant ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant KYBER = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 constant NONE = type(uint256).max;
    uint256 constant FORK_BLOCK = 26490425;

    IToken2 usds = IToken2(USDS);
    IStUsdsT2 st = IStUsdsT2(ST_USDS);
    IToken2 dai = IToken2(DAI);
    StUsdsArb2 arbC;
    address keeper = makeAddr("arbKeeper");
    address builder = makeAddr("builder");
    address depositor = makeAddr("depositor");
    address attacker = makeAddr("attacker");

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://mainnet.gateway.tenderly.co")), FORK_BLOCK);
        vm.roll(FORK_BLOCK + 1);
        vm.warp(block.timestamp + 12);
        vm.coinbase(builder);
        vm.deal(builder, 0);
        arbC = new StUsdsArb2(DAI, USDS, ST_USDS, DAI_USDS, FLASH, ETH_USD, MAIN, keeper, _venues());
        vm.deal(address(arbC), 0); // the fork may hold dust at this address
    }

    // ---------- helpers ----------

    function _venues() internal pure returns (address[] memory v) {
        v = new address[](4);
        v[0] = CURVE;
        v[1] = PSM;
        v[2] = ROUTER02;
        v[3] = KYBER;
    }

    function _free(uint256 amount) internal {
        // Someone deposits fresh USDS into stUSDS: that much becomes withdrawable.
        deal(USDS, depositor, amount);
        vm.startPrank(depositor);
        usds.approve(ST_USDS, amount);
        st.deposit(amount, depositor);
        vm.stopPrank();
    }

    /// Buy through the pool's add-liquidity / remove-one-coin path (cheaper than a plain swap).
    function _buyViaLp(uint256 amount) internal pure returns (StUsdsArb2.Step[] memory s) {
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount;
        s = new StUsdsArb2.Step[](2);
        s[0] = StUsdsArb2.Step(CURVE, USDS, amount, NONE, abi.encodeCall(ICurve.add_liquidity, (amounts, 0)));
        // Burn every LP token just minted: the amount is written into the first argument.
        s[1] = StUsdsArb2.Step(CURVE, CURVE, NONE, 4, abi.encodeCall(ICurve.remove_liquidity_one_coin, (0, 1, 0)));
    }

    function _buyViaSwap(uint256 amount) internal pure returns (StUsdsArb2.Step[] memory s) {
        s = new StUsdsArb2.Step[](1);
        s[0] = StUsdsArb2.Step(CURVE, USDS, amount, NONE, abi.encodeCall(ICurve.exchange, (0, 1, amount, 0)));
    }

    /// USDS -> USDC at Sky's converter (1:1), then USDC -> ETH on Uniswap.
    function _tip(uint256 tipUsds) internal view returns (StUsdsArb2.Step[] memory s) {
        uint256 gem = tipUsds / 1e12;
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(
            IRouter02.exactInputSingle, (IRouter02.ExactInputSingleParams(USDC, WETH, 500, address(2), gem, 0, 0))
        );
        calls[1] = abi.encodeCall(IRouter02.unwrapWETH9, (0, address(arbC)));
        s = new StUsdsArb2.Step[](2);
        s[0] = StUsdsArb2.Step(PSM, USDS, gem * 1e12, NONE, abi.encodeCall(IPsm.buyGem, (address(arbC), gem)));
        s[1] = StUsdsArb2.Step(ROUTER02, USDC, gem, NONE, abi.encodeCall(IRouter02.multicall, (calls)));
    }

    function _plan(uint256 amount, uint256 tipUsds, uint256 minNet) internal view returns (StUsdsArb2.Plan memory p) {
        p.flash = amount;
        p.buy = _buyViaLp(amount);
        p.tipUsds = tipUsds;
        p.tip = tipUsds == 0 ? new StUsdsArb2.Step[](0) : _tip(tipUsds);
        p.minNet = minNet;
    }

    function _assertHoldsNothing() internal view {
        assertEq(usds.balanceOf(address(arbC)), 0, "holds USDS");
        assertEq(st.balanceOf(address(arbC)), 0, "holds stUSDS");
        assertEq(dai.balanceOf(address(arbC)), 0, "holds DAI");
        assertEq(IToken2(USDC).balanceOf(address(arbC)), 0, "holds USDC");
        assertEq(IToken2(CURVE).balanceOf(address(arbC)), 0, "holds pool tokens");
        assertEq(address(arbC).balance, 0, "holds ETH");
        assertEq(usds.allowance(address(arbC), CURVE), 0, "left a USDS approval at the pool");
        assertEq(usds.allowance(address(arbC), PSM), 0, "left a USDS approval at the converter");
        assertEq(IToken2(USDC).allowance(address(arbC), ROUTER02), 0, "left a USDC approval");
        assertEq(IToken2(CURVE).allowance(address(arbC), CURVE), 0, "left a pool-token approval");
        assertEq(dai.allowance(address(arbC), DAI_USDS), 0, "left a DAI approval");
    }

    // ---------- the happy path ----------

    function test_profitGoesToMainWallet() public {
        _free(50_000e18);
        uint256 before = usds.balanceOf(MAIN);
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, 0, 2_000e18));
        assertGt(net, 2_000e18);
        assertEq(usds.balanceOf(MAIN) - before, net, "profit not at main wallet");
        assertEq(st.balanceOf(MAIN), mainShares, "touched the main wallet's stUSDS");
        _assertHoldsNothing();
        console2.log("40k buy via the pool's liquidity path: net profit USDS", net / 1e18);
    }

    function test_liquidityPathBeatsPlainSwap() public {
        _free(50_000e18);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 viaLp = arbC.arb(_plan(40_000e18, 0, 0));
        vm.revertToState(snap);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        p.buy = _buyViaSwap(40_000e18);
        vm.prank(keeper);
        uint256 viaSwap = arbC.arb(p);
        assertGt(viaLp, viaSwap, "liquidity path should be the cheaper one");
        _assertHoldsNothing();
        console2.log("net via liquidity path", viaLp / 1e18, "via swap", viaSwap / 1e18);
    }

    function test_builderTipIsPaidFromProfitAtOraclePrice() public {
        _free(50_000e18);
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, 2_500e18, 100e18));
        assertGt(builder.balance, 1.4 ether, "builder not tipped");
        assertGt(net, 100e18);
        assertEq(usds.balanceOf(MAIN) - before, net);
        _assertHoldsNothing();
        console2.log("tip wei to builder", builder.balance, "net USDS", net / 1e18);
    }

    function test_ninetyNinePercentTipStillLeavesProfit() public {
        _free(50_000e18);
        // First learn the profit, then give 99% of it to the builder.
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 profit = arbC.arb(_plan(40_000e18, 0, 0));
        vm.revertToState(snap);
        uint256 tipUsds = profit * 99 / 100 / 1e12 * 1e12;
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, tipUsds, 1e18));
        assertApproxEqAbs(net, profit - tipUsds, 1e15, "what is left must be exactly profit minus tip");
        assertGt(builder.balance, 0);
        _assertHoldsNothing();
        console2.log("profit", profit / 1e18, "kept after a 99% tip", net / 1e18);
    }

    // ---------- the quoter ----------

    function test_quoterMatchesTheRealPurchaseExactly() public {
        _free(50_000e18);
        StUsdsQuoter q = new StUsdsQuoter();
        uint256[] memory xs = new uint256[](3);
        xs[0] = 10_000e18;
        xs[1] = 40_000e18;
        xs[2] = 400_000_000e18; // absurdly large: still answered, at an absurd price
        (uint256[] memory lp, uint256[] memory shares) = q.quote(xs);
        assertGt(shares[0], 0);
        assertGt(lp[1], 0);
        assertLt(shares[2], 2_100_000e18, "cannot buy more stUSDS than the pool holds");
        // Larger purchases get a worse price.
        assertGt(shares[0] * 4, shares[1]);
        // Quoting leaves nothing behind.
        assertEq(usds.balanceOf(address(q)), 0);
        assertEq(st.balanceOf(address(q)), 0);
        assertEq(IToken2(CURVE).balanceOf(address(q)), 0);

        vm.recordLogs();
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, 0, 0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 bought;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(arbC) && logs[i].topics[0] == StUsdsArb2.Arb.selector) {
                (, bought,,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
            }
        }
        assertEq(bought, shares[1], "quote differs from the real purchase");
        // Shares redeem for their stated value, to the last few wei.
        assertApproxEqAbs(net, st.convertToAssets(shares[1]) - 40_000e18, 10);
    }

    function test_quoterCannotBeUsedToMoveAnything() public {
        StUsdsQuoter q = new StUsdsQuoter();
        vm.expectRevert();
        q.one(1_000e18);
        vm.prank(attacker);
        vm.expectRevert(StUsdsQuoter.OnlyFlash.selector);
        q.onFlashLoan(address(q), DAI, 1e18, 0, "");
        vm.prank(attacker);
        vm.expectRevert();
        IFlash2(FLASH).flashLoan(address(q), DAI, 1e18, "");
    }

    // ---------- things that must fail ----------

    function test_noLiquidityRevertsAndNothingMoves() public {
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.NotFullyRedeemable.selector);
        arbC.arb(_plan(40_000e18, 0, 0));
        assertEq(usds.balanceOf(MAIN), before);
        _assertHoldsNothing();
    }

    function test_partialLiquidityRevertsInsteadOfHoldingStUsds() public {
        _free(10_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.NotFullyRedeemable.selector);
        arbC.arb(_plan(40_000e18, 0, 0));
        _assertHoldsNothing();
    }

    function test_minimumProfitIsEnforced() public {
        _free(50_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.Unprofitable.selector);
        arbC.arb(_plan(40_000e18, 0, 20_000e18));
        _assertHoldsNothing();
    }

    function test_onlyKeeperCanRun() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        vm.prank(attacker);
        vm.expectRevert(StUsdsArb2.NotKeeper.selector);
        arbC.arb(p);
        vm.prank(MAIN);
        vm.expectRevert(StUsdsArb2.NotKeeper.selector);
        arbC.arb(p);
    }

    function test_onlyMainWalletCanChangeKeeper() public {
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb2.NotOwner.selector);
        arbC.setKeeper(attacker);
        vm.prank(MAIN);
        arbC.setKeeper(attacker);
        assertEq(arbC.keeper(), attacker);
    }

    function test_flashCallbackCannotBeTriggeredByOthers() public {
        bytes memory data = abi.encode(_plan(40_000e18, 0, 0));
        vm.prank(attacker);
        vm.expectRevert(StUsdsArb2.BadCallback.selector);
        arbC.onFlashLoan(address(arbC), DAI, 1e18, 0, data);
        // A real flash loan started by someone else, pointed at the arb, is refused too.
        vm.prank(attacker);
        vm.expectRevert();
        IFlash2(FLASH).flashLoan(address(arbC), DAI, 1e18, data);
    }

    function test_callsOutsideTheVenueListRevert() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        // Try to make the arb send its USDS away with a direct token call.
        p.buy[0] = StUsdsArb2.Step(USDS, address(0), 0, NONE, abi.encodeCall(IToken2.transfer, (attacker, 40_000e18)));
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(StUsdsArb2.NotVenue.selector, USDS));
        arbC.arb(p);
        p.buy[0] = StUsdsArb2.Step(attacker, USDS, 40_000e18, NONE, "");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(StUsdsArb2.NotVenue.selector, attacker));
        arbC.arb(p);
        _assertHoldsNothing();
    }

    function test_venueListCannotContainTokensOrSkyContracts() public {
        address[] memory v = new address[](1);
        v[0] = USDS;
        vm.expectRevert("bad venue");
        new StUsdsArb2(DAI, USDS, ST_USDS, DAI_USDS, FLASH, ETH_USD, MAIN, keeper, v);
        v[0] = ST_USDS;
        vm.expectRevert("bad venue");
        new StUsdsArb2(DAI, USDS, ST_USDS, DAI_USDS, FLASH, ETH_USD, MAIN, keeper, v);
        // An address with no code is not a venue. (Well-known test addresses carry delegated code on mainnet, so use a fresh one.)
        address empty = address(uint160(uint256(keccak256("stusds arb: an address nobody uses"))));
        assertEq(empty.code.length, 0);
        v[0] = empty;
        vm.expectRevert("bad venue");
        new StUsdsArb2(DAI, USDS, ST_USDS, DAI_USDS, FLASH, ETH_USD, MAIN, keeper, v);
        assertFalse(arbC.venue(empty));
        assertTrue(arbC.venue(CURVE));
    }

    function test_buySendingSharesElsewhereReverts() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        // A swap that pays the stUSDS to someone else leaves nothing to redeem.
        p.buy = new StUsdsArb2.Step[](1);
        p.buy[0] = StUsdsArb2.Step(
            CURVE,
            USDS,
            40_000e18,
            NONE,
            abi.encodeWithSignature("exchange(int128,int128,uint256,uint256,address)", 0, 1, 40_000e18, 0, attacker)
        );
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb2.NothingBought.selector);
        arbC.arb(p);
        assertEq(st.balanceOf(attacker), 0);
    }

    function test_garbageVenueCalldataReverts() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        p.buy[0].data = hex"deadbeef";
        vm.prank(keeper);
        vm.expectRevert();
        arbC.arb(p);
        _assertHoldsNothing();
    }

    function test_patchOutsideTheCalldataReverts() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 0, 0);
        p.buy[1].patch = 80; // the call is 100 bytes long: 80 + 32 runs past its end
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb2.BadPatch.selector);
        arbC.arb(p);
    }

    function test_tipCannotSpendMoreThanAllowed() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 500e18, 0);
        p.tipUsds = 100e18; // the steps still convert 500
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.TipOverspent.selector);
        arbC.arb(p);
        assertEq(builder.balance, 0);
    }

    function test_tipAtABadRateIsRejected() public {
        _free(50_000e18);
        StUsdsArb2.Plan memory p = _plan(40_000e18, 500e18, 0);
        // Convert the USDS to USDC but never to ETH: the builder would get nothing for 500 USDS.
        StUsdsArb2.Step[] memory onlyFirst = new StUsdsArb2.Step[](1);
        onlyFirst[0] = p.tip[0];
        p.tip = onlyFirst;
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.BadTipRate.selector);
        arbC.arb(p);
        assertEq(builder.balance, 0);
        _assertHoldsNothing();
    }

    function test_donationsCannotBlockAndEndUpAtMainWallet() public {
        _free(50_000e18);
        deal(USDS, attacker, 7e18);
        vm.prank(attacker);
        usds.transfer(address(arbC), 7e18);
        deal(USDC, address(arbC), 5e6);
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, 0, 2_000e18));
        assertEq(usds.balanceOf(MAIN) - before, net);
        // Anyone can push a stray token on to the main wallet, and only there.
        uint256 usdcBefore = IToken2(USDC).balanceOf(MAIN);
        vm.prank(attacker);
        arbC.sweep(USDC);
        assertEq(IToken2(USDC).balanceOf(MAIN) - usdcBefore, 5e6);
        _assertHoldsNothing();
    }

    function test_rejectsEthOutsideARun() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(arbC).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------- together with the main wallet's exit ----------

    function test_mainExitTakesTheLiquidityFirstThenArbTakesTheRest() public {
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(MAIN);
        st.approve(MAIN_EXIT, mainShares);
        uint256 mainValue = st.convertToAssets(mainShares);
        _free(mainValue + 50_000e18);

        uint256 usdsBefore = usds.balanceOf(MAIN);
        vm.prank(BOT_KEY);
        StUsdsExit(MAIN_EXIT).exit(type(uint256).max, 0);
        assertEq(st.balanceOf(MAIN), 0, "main wallet not fully out");
        assertApproxEqAbs(usds.balanceOf(MAIN) - usdsBefore, mainValue, 2, "main did not get 1:1");

        vm.prank(keeper);
        uint256 net = arbC.arb(_plan(40_000e18, 0, 2_000e18));
        assertGt(net, 2_000e18);
        _assertHoldsNothing();
    }

    function test_arbNeverCompetesWithMainExitWhenLiquidityIsShort() public {
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(MAIN);
        st.approve(MAIN_EXIT, mainShares);
        _free(200_000e18); // less than the main position
        vm.prank(BOT_KEY);
        StUsdsExit(MAIN_EXIT).exit(type(uint256).max, 0);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb2.NotFullyRedeemable.selector);
        arbC.arb(_plan(40_000e18, 0, 0));
        _assertHoldsNothing();
    }

    function test_arbHasNoHoldOnTheMainWallet() public view {
        assertEq(st.allowance(MAIN, address(arbC)), 0);
        assertEq(usds.allowance(MAIN, address(arbC)), 0);
    }

    // ---------- code shape ----------

    function test_bytecodeHasNoDelegatecallCreateOrSelfdestruct() public view {
        bytes memory code = address(arbC).code;
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf4, "DELEGATECALL");
            assertTrue(op != 0xf2, "CALLCODE");
            assertTrue(op != 0xf0 && op != 0xf5, "CREATE");
            assertTrue(op != 0xff, "SELFDESTRUCT");
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f; // skip PUSH data
            i++;
        }
    }
}
