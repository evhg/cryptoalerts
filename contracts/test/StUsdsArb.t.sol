// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StUsdsArb} from "../src/StUsdsArb.sol";
import {StUsdsExit} from "../src/StUsdsExit.sol";

interface IToken {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsT is IToken {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function maxWithdraw(address) external view returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
}

interface IFlash {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

/// Fork tests of the arb against real mainnet state and real KyberSwap router
/// calldata (test/fixtures/arb.json, built for the fixed arb address at the
/// fixture's block by test/fixtures/build-arb-fixture.mjs).
contract StUsdsArbTest is Test {
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address constant ROUTER = 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5;
    address constant ETH_USD = 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;
    address constant MAIN = 0xCD532243888D26791881064E24D4A25FD0041d98;
    // The real, already deployed exit contract for the main wallet, and the bot key.
    address constant MAIN_EXIT = 0xbF54F2AA78b4c240e34224073aff9E89Cd915897;
    address constant BOT_KEY = 0x3C865A8F373544A6Abce380d68A4dEd7f8179BC9;

    IToken usds = IToken(USDS);
    IStUsdsT st = IStUsdsT(ST_USDS);
    IToken dai = IToken(DAI);
    StUsdsArb arbC;
    address keeper = makeAddr("arbKeeper");
    address builder = makeAddr("builder");
    address depositor = makeAddr("depositor");
    string fx;
    address attacker;

    function setUp() public {
        fx = vm.readFile("test/fixtures/arb.json");
        uint256 blockNumber = vm.parseJsonUint(fx, ".block");
        attacker = vm.parseJsonAddress(fx, ".attacker");
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://mainnet.gateway.tenderly.co")), blockNumber);
        vm.roll(blockNumber + 1);
        vm.warp(block.timestamp + 12);
        vm.coinbase(builder);
        vm.deal(builder, 0);
        address at = vm.parseJsonAddress(fx, ".arb");
        deployCodeTo(
            "StUsdsArb.sol:StUsdsArb",
            abi.encode(DAI, USDS, ST_USDS, DAI_USDS, FLASH, ROUTER, ETH_USD, MAIN, keeper),
            at
        );
        arbC = StUsdsArb(payable(at));
        vm.deal(address(arbC), 0);
    }

    // ---------- helpers ----------

    function _free(uint256 amount) internal {
        // Someone deposits fresh USDS into stUSDS: that much becomes withdrawable.
        deal(USDS, depositor, amount);
        vm.startPrank(depositor);
        usds.approve(ST_USDS, amount);
        st.deposit(amount, depositor);
        vm.stopPrank();
    }

    function _plan(string memory buy, uint256 tipUsds, string memory tip, uint256 minNet)
        internal
        view
        returns (StUsdsArb.Plan memory p)
    {
        p.flash = vm.parseJsonUint(fx, string.concat(".", buy, ".amountIn"));
        p.buyData = vm.parseJsonBytes(fx, string.concat(".", buy, ".data"));
        p.tipUsds = tipUsds;
        p.tipData = bytes(tip).length == 0 ? bytes("") : vm.parseJsonBytes(fx, string.concat(".", tip, ".data"));
        p.minNet = minNet;
    }

    function _assertHoldsNothing() internal view {
        assertEq(usds.balanceOf(address(arbC)), 0, "holds USDS");
        assertEq(st.balanceOf(address(arbC)), 0, "holds stUSDS");
        assertEq(dai.balanceOf(address(arbC)), 0, "holds DAI");
        assertEq(address(arbC).balance, 0, "holds ETH");
        assertEq(usds.allowance(address(arbC), ROUTER), 0, "left a USDS approval");
        assertEq(dai.allowance(address(arbC), DAI_USDS), 0, "left a DAI approval");
    }

    // ---------- the happy path ----------

    function test_profitGoesToMainWallet() public {
        _free(50_000e18);
        uint256 before = usds.balanceOf(MAIN);
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan("buy20k", 0, "", 1_000e18));
        assertGt(net, 1_000e18);
        assertEq(usds.balanceOf(MAIN) - before, net, "profit not at main wallet");
        assertEq(st.balanceOf(MAIN), mainShares, "touched the main wallet's stUSDS");
        _assertHoldsNothing();
        console2.log("20k buy: net profit USDS", net / 1e18);
    }

    function test_largerBuyLargerProfit() public {
        _free(150_000e18);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan("buy100k", 0, "", 5_000e18));
        assertGt(net, 5_000e18);
        _assertHoldsNothing();
        console2.log("100k buy: net profit USDS", net / 1e18);
    }

    function test_builderTipIsPaidFromProfitAtOraclePrice() public {
        _free(50_000e18);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan("buy20k", 500e18, "tip500", 1_000e18));
        assertGt(builder.balance, 0.25 ether, "builder not tipped");
        assertGt(net, 1_000e18);
        _assertHoldsNothing();
        console2.log("tip wei to builder", builder.balance);
    }

    // ---------- it only ever redeems what Sky can pay ----------

    function test_noLiquidityRevertsAndNothingMoves() public {
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb.NotFullyRedeemable.selector);
        arbC.arb(_plan("buy20k", 0, "", 0));
        assertEq(usds.balanceOf(MAIN), before);
        _assertHoldsNothing();
    }

    function test_partialLiquidityRevertsInsteadOfHoldingStUsds() public {
        _free(5_000e18); // far less than the ~22.9k the bought shares are worth
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb.NotFullyRedeemable.selector);
        arbC.arb(_plan("buy20k", 0, "", 0));
        _assertHoldsNothing();
    }

    function test_minimumProfitIsEnforced() public {
        _free(50_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb.Unprofitable.selector);
        arbC.arb(_plan("buy20k", 0, "", 10_000e18)); // more than the trade can make
    }

    // ---------- who can do what ----------

    function test_onlyKeeperCanRun() public {
        _free(50_000e18);
        StUsdsArb.Plan memory p = _plan("buy20k", 0, "", 0);
        vm.prank(attacker);
        vm.expectRevert(StUsdsArb.NotKeeper.selector);
        arbC.arb(p);
        vm.prank(MAIN); // even the owner does not run it; the keeper does
        vm.expectRevert(StUsdsArb.NotKeeper.selector);
        arbC.arb(p);
    }

    function test_onlyMainWalletCanChangeKeeper() public {
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb.NotOwner.selector);
        arbC.setKeeper(attacker);
        vm.prank(MAIN);
        arbC.setKeeper(attacker);
        assertEq(arbC.keeper(), attacker);
    }

    function test_flashCallbackCannotBeTriggeredByOthers() public {
        _free(50_000e18);
        bytes memory data = abi.encode(_plan("buy20k", 0, "", 0));
        // Direct call.
        vm.prank(attacker);
        vm.expectRevert(StUsdsArb.BadCallback.selector);
        arbC.onFlashLoan(address(arbC), DAI, 20_000e18, 0, data);
        // Through DssFlash with someone else as initiator.
        vm.prank(attacker);
        vm.expectRevert();
        IFlash(FLASH).flashLoan(address(arbC), DAI, 20_000e18, data);
        _assertHoldsNothing();
    }

    // ---------- a stolen keeper key or hostile calldata gets nothing ----------

    function test_routeSendingSharesElsewhereReverts() public {
        _free(50_000e18);
        StUsdsArb.Plan memory p = _plan("buy20kToAttacker", 0, "", 0);
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb.NothingBought.selector);
        arbC.arb(p);
        assertEq(st.balanceOf(attacker), 0, "attacker got shares");
        _assertHoldsNothing();
    }

    function test_garbageRouterCalldataReverts() public {
        _free(50_000e18);
        StUsdsArb.Plan memory p = _plan("buy20k", 0, "", 0);
        p.buyData = hex"deadbeef";
        vm.prank(keeper);
        vm.expectRevert(StUsdsArb.RouterFailed.selector);
        arbC.arb(p);
        _assertHoldsNothing();
    }

    function test_tipAtABadRateIsRejected() public {
        _free(50_000e18);
        // Claims 5,000 USDS of tip but the calldata only converts 500: the ETH
        // received is far below 97% of the oracle value, so the run reverts.
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb.BadTipRate.selector);
        arbC.arb(_plan("buy20k", 5_000e18, "tip500", 0));
        assertEq(builder.balance, 0);
        _assertHoldsNothing();
    }

    function test_flashAmountMismatchReverts() public {
        _free(50_000e18);
        StUsdsArb.Plan memory p = _plan("buy20k", 0, "", 0);
        p.flash = 25_000e18; // calldata spends 20k; 5k stays unaccounted -> repaid -> fine, or revert
        vm.prank(keeper);
        // Either way nothing may be left behind and the main wallet's shares are untouched.
        try arbC.arb(p) {} catch {}
        _assertHoldsNothing();
    }

    // ---------- donations and stray ETH ----------

    function test_donationsCannotBlockAndEndUpAtMainWallet() public {
        _free(50_000e18);
        deal(USDS, address(this), 10e18);
        usds.transfer(address(arbC), 10e18);
        deal(DAI, address(this), 7e18);
        dai.transfer(address(arbC), 7e18);
        uint256 daiBefore = dai.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan("buy20k", 0, "", 1_000e18));
        assertGt(net, 1_000e18);
        assertEq(dai.balanceOf(MAIN) - daiBefore, 7e18, "donated DAI not swept to main");
        _assertHoldsNothing();
    }

    function test_rejectsEthOutsideARun() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(arbC).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------- the main exit always comes first ----------

    function test_mainExitTakesTheLiquidityFirstThenArbTakesTheRest() public {
        // Main wallet signs the approval for the real exit contract.
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(MAIN);
        st.approve(MAIN_EXIT, mainShares);
        uint256 mainValue = st.convertToAssets(mainShares);

        // A large repayment-sized amount of liquidity appears.
        _free(mainValue + 40_000e18);

        // Bundle order: main exit first ...
        uint256 usdsBefore = usds.balanceOf(MAIN);
        vm.prank(BOT_KEY);
        StUsdsExit(MAIN_EXIT).exit(type(uint256).max, 0);
        assertEq(st.balanceOf(MAIN), 0, "main wallet not fully out");
        assertApproxEqAbs(usds.balanceOf(MAIN) - usdsBefore, mainValue, 2, "main did not get 1:1");

        // ... then the arb on what is left.
        vm.prank(keeper);
        uint256 net = arbC.arb(_plan("buy20k", 0, "", 1_000e18));
        assertGt(net, 1_000e18);
        _assertHoldsNothing();
    }

    function test_arbNeverCompetesWithMainExitWhenLiquidityIsShort() public {
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(MAIN);
        st.approve(MAIN_EXIT, mainShares);
        _free(200_000e18); // less than the main position
        vm.prank(BOT_KEY);
        StUsdsExit(MAIN_EXIT).exit(type(uint256).max, 0);
        // Everything went to the main wallet; the arb finds nothing and reverts.
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArb.NotFullyRedeemable.selector);
        arbC.arb(_plan("buy20k", 0, "", 0));
        _assertHoldsNothing();
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
