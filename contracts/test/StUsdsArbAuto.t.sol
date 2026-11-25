// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StUsdsArbAuto} from "../src/StUsdsArbAuto.sol";
import {StUsdsExit} from "../src/StUsdsExit.sol";

interface IToken3 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsT3 is IToken3 {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function maxWithdraw(address) external view returns (uint256);
}

interface IFlash3 {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

/// Fork tests of the self-sizing arb against real mainnet contracts.
contract StUsdsArbAutoTest is Test {
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address constant DAI_USDS = 0x3225737a9Bbb6473CB4a45b7244ACa2BeFdB276A;
    address constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address constant MAIN = 0xCD532243888D26791881064E24D4A25FD0041d98;
    address constant MAIN_EXIT = 0xbF54F2AA78b4c240e34224073aff9E89Cd915897;
    address constant BOT_KEY = 0x3C865A8F373544A6Abce380d68A4dEd7f8179BC9;
    address constant CURVE = 0x2C7C98A3b1582D83c43987202aEFf638312478aE;
    address constant PSM = 0xA188EEC8F81263234dA3622A406892F3D630f98c;
    address constant ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 constant FORK_BLOCK = 26490425;
    uint256 constant NO_CAP = type(uint256).max;

    IToken3 usds = IToken3(USDS);
    IStUsdsT3 st = IStUsdsT3(ST_USDS);
    IToken3 dai = IToken3(DAI);
    StUsdsArbAuto arbC;
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
        arbC = new StUsdsArbAuto(MAIN, keeper);
        vm.deal(address(arbC), 0); // the fork may hold dust at this address
    }

    function _free(uint256 amount) internal {
        // Someone deposits fresh USDS into stUSDS: that much becomes withdrawable.
        deal(USDS, depositor, amount);
        vm.startPrank(depositor);
        usds.approve(ST_USDS, amount);
        st.deposit(amount, depositor);
        vm.stopPrank();
    }

    function _assertHoldsNothing() internal view {
        assertEq(usds.balanceOf(address(arbC)), 0, "holds USDS");
        assertEq(st.balanceOf(address(arbC)), 0, "holds stUSDS");
        assertEq(dai.balanceOf(address(arbC)), 0, "holds DAI");
        assertEq(IToken3(USDC).balanceOf(address(arbC)), 0, "holds USDC");
        assertEq(IToken3(CURVE).balanceOf(address(arbC)), 0, "holds pool tokens");
        assertEq(address(arbC).balance, 0, "holds ETH");
        assertEq(usds.allowance(address(arbC), CURVE), 0, "left a USDS approval at the pool");
        assertEq(usds.allowance(address(arbC), PSM), 0, "left a USDS approval at the converter");
        assertEq(IToken3(USDC).allowance(address(arbC), ROUTER02), 0, "left a USDC approval");
        assertEq(dai.allowance(address(arbC), DAI_USDS), 0, "left a DAI approval");
    }

    // ---------- it sizes itself ----------

    function test_seesExactlyWhatIsWithdrawable() public {
        uint256 start = arbC.available();
        _free(40_000e18);
        assertApproxEqAbs(arbC.available(), start + 40_000e18, 1e18, "available() does not match the freed liquidity");
    }

    function test_takesWhatIsThereAndPaysTheMainWallet() public {
        _free(40_000e18);
        uint256 avail = arbC.available();
        uint256 before = usds.balanceOf(MAIN);
        uint256 mainShares = st.balanceOf(MAIN);
        vm.prank(keeper);
        uint256 net = arbC.run(1_000e18, NO_CAP, 0, 1_000e18, 20e18);
        assertGt(net, 2_000e18);
        assertEq(usds.balanceOf(MAIN) - before, net, "profit not at main wallet");
        assertEq(st.balanceOf(MAIN), mainShares, "touched the main wallet's stUSDS");
        // Nearly all of the freed liquidity was used.
        assertLt(arbC.available(), avail / 200, "left more than half a percent unused");
        _assertHoldsNothing();
        console2.log("40k freed: net profit USDS", net / 1e18, "left unused USDS", arbC.available() / 1e18);
    }

    function testFuzz_anySizeEndsWithProfitOrNothing(uint256 freed) public {
        freed = bound(freed, 30e18, 600_000e18);
        _free(freed);
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        try arbC.run(20e18, 400_000e18, 9900, 0, 20e18) returns (uint256 net) {
            assertEq(usds.balanceOf(MAIN) - before, net);
        } catch {
            assertEq(usds.balanceOf(MAIN), before, "a failed run moved money");
        }
        _assertHoldsNothing();
    }

    function test_smallAndLargeOpenings() public {
        uint256 snap = vm.snapshotState();
        _free(150e18);
        vm.prank(keeper);
        uint256 small = arbC.run(100e18, NO_CAP, 0, 1e18, 20e18);
        assertGt(small, 5e18);
        _assertHoldsNothing();
        vm.revertToState(snap);
        _free(300_000e18);
        vm.prank(keeper);
        uint256 large = arbC.run(100e18, NO_CAP, 0, 1e18, 20e18);
        assertGt(large, 5_000e18);
        _assertHoldsNothing();
        console2.log("150 freed: net", small / 1e18, "| 300k freed: net", large / 1e18);
    }

    function test_spendingCapIsRespected() public {
        _free(300_000e18);
        uint256 avail = arbC.available();
        vm.prank(keeper);
        arbC.run(100e18, 50_000e18, 0, 1e18, 20e18);
        // About 51,000 was spent (the cap plus its 2% top-up room), so most of the liquidity is still there.
        assertGt(arbC.available(), avail - 60_000e18);
        _assertHoldsNothing();
    }

    function test_builderGetsItsShareAtOraclePrice() public {
        _free(40_000e18);
        uint256 snap = vm.snapshotState();
        vm.prank(keeper);
        uint256 profit = arbC.run(1_000e18, NO_CAP, 0, 0, 20e18);
        vm.revertToState(snap);
        vm.prank(keeper);
        uint256 net = arbC.run(1_000e18, NO_CAP, 9950, 1e18, 20e18);
        assertApproxEqRel(net, profit / 200, 0.02e18, "kept share is not about 0.5% of the profit");
        assertGt(builder.balance, 1.5 ether, "builder not tipped");
        _assertHoldsNothing();
        console2.log("profit", profit / 1e18, "kept at 99.5%", net / 1e18);
        console2.log("builder wei", builder.balance);
    }

    function test_tipShrinksToKeepTheMinimum() public {
        _free(300e18);
        // About 27 USDS of profit: 99.5% to the builder would leave 0.13, so the tip gives way to the 2 USDS minimum.
        vm.prank(keeper);
        uint256 net = arbC.run(100e18, NO_CAP, 9950, 2e18, 20e18);
        assertApproxEqAbs(net, 2e18, 2e12, "should keep exactly the minimum");
        assertGt(builder.balance, 0, "builder still gets the rest");
        _assertHoldsNothing();
    }

    function test_tinyProfitSkipsTheTipConversion() public {
        _free(40e18);
        vm.prank(keeper);
        uint256 net = arbC.run(20e18, NO_CAP, 100, 0, 20e18); // 1% of about 3 USDS is under the 0.05 USDS minimum
        assertGt(net, 1e18);
        assertEq(builder.balance, 0);
        _assertHoldsNothing();
    }

    // ---------- things that must fail ----------

    function test_nothingWithdrawableRevertsAndCostsNothing() public {
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbAuto.TooLittle.selector);
        arbC.run(100e18, NO_CAP, 9900, 0, 20e18);
        assertEq(usds.balanceOf(MAIN), before);
        _assertHoldsNothing();
    }

    function test_belowTheMinimumOpeningReverts() public {
        _free(60e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbAuto.TooLittle.selector);
        arbC.run(150e18, NO_CAP, 9900, 0, 20e18);
    }

    function test_minimumProfitIsEnforced() public {
        _free(40_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbAuto.Unprofitable.selector);
        arbC.run(1_000e18, NO_CAP, 0, 20_000e18, 20e18);
        _assertHoldsNothing();
    }

    function test_tipShareIsCapped() public {
        _free(40_000e18);
        vm.prank(keeper);
        vm.expectRevert(StUsdsArbAuto.BadTipShare.selector);
        arbC.run(1_000e18, NO_CAP, 9996, 0, 20e18);
    }

    function test_onlyKeeperCanRun() public {
        _free(40_000e18);
        vm.prank(attacker);
        vm.expectRevert(StUsdsArbAuto.NotKeeper.selector);
        arbC.run(1_000e18, NO_CAP, 0, 0, 20e18);
        vm.prank(MAIN);
        vm.expectRevert(StUsdsArbAuto.NotKeeper.selector);
        arbC.run(1_000e18, NO_CAP, 0, 0, 20e18);
    }

    function test_onlyMainWalletCanChangeKeeper() public {
        vm.prank(keeper);
        vm.expectRevert(StUsdsArbAuto.NotOwner.selector);
        arbC.setKeeper(attacker);
        vm.prank(MAIN);
        arbC.setKeeper(attacker);
        assertEq(arbC.keeper(), attacker);
    }

    function test_flashCallbackCannotBeTriggeredByOthers() public {
        bytes memory data = abi.encode(StUsdsArbAuto.Job(1, 1, 1, 1e18, 0, 0, 0));
        vm.prank(attacker);
        vm.expectRevert(StUsdsArbAuto.BadCallback.selector);
        arbC.onFlashLoan(address(arbC), DAI, 1e18, 0, data);
        vm.prank(attacker);
        vm.expectRevert();
        IFlash3(FLASH).flashLoan(address(arbC), DAI, 1e18, data);
    }

    function test_donationsEndUpAtMainWallet() public {
        _free(40_000e18);
        deal(USDC, address(arbC), 5e6);
        deal(USDS, attacker, 7e18);
        vm.prank(attacker);
        usds.transfer(address(arbC), 7e18);
        vm.prank(keeper);
        arbC.run(1_000e18, NO_CAP, 0, 1e18, 20e18);
        uint256 usdcBefore = IToken3(USDC).balanceOf(MAIN);
        vm.prank(attacker);
        arbC.sweep(USDC);
        assertEq(IToken3(USDC).balanceOf(MAIN) - usdcBefore, 5e6);
        _assertHoldsNothing();
    }

    function test_rejectsEthOutsideARun() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(arbC).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ---------- together with the main wallet's exit ----------

    function test_afterTheMainExitItTakesOnlyWhatIsLeft() public {
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
        uint256 net = arbC.run(1_000e18, NO_CAP, 0, 1_000e18, 20e18);
        assertGt(net, 2_500e18);
        _assertHoldsNothing();
    }

    function test_hasNoHoldOnTheMainWallet() public view {
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
