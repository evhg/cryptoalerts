// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {StUsdsArbLite} from "../src/StUsdsArbLite.sol";
import {StUsdsExit} from "../src/StUsdsExit.sol";

interface IToken4 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IStUsdsT4 is IToken4 {
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function convertToAssets(uint256) external view returns (uint256);
    function convertToShares(uint256) external view returns (uint256);
    function maxWithdraw(address) external view returns (uint256);
}

interface IFlash4 {
    function flashLoan(address receiver, address token, uint256 amount, bytes calldata data) external returns (bool);
}

interface IMorpho4 {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// Fork tests of the lean arb against real mainnet contracts.
contract StUsdsArbLiteTest is Test {
    address constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address constant FLASH = 0x60744434d6339a6B27d73d9Eda62b6F66a0a04FA;
    address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant MAIN = 0xCD532243888D26791881064E24D4A25FD0041d98;
    address constant MAIN_EXIT = 0xbF54F2AA78b4c240e34224073aff9E89Cd915897;
    address constant BOT_KEY = 0x3C865A8F373544A6Abce380d68A4dEd7f8179BC9;
    address constant CURVE = 0x2C7C98A3b1582D83c43987202aEFf638312478aE;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 constant FORK_BLOCK = 26490425;
    uint256 constant NO_CAP = type(uint256).max;
    uint256 constant NEVER = type(uint256).max; // "never use the two-step route"
    uint256 constant RATE = 6e14; // wei per USDS with ETH near $1,667

    IToken4 usds = IToken4(USDS);
    IStUsdsT4 st = IStUsdsT4(ST_USDS);
    StUsdsArbLite arbC;
    address keeper = makeAddr("arbKeeper");
    address builder = makeAddr("builder");
    address depositor = makeAddr("depositor");
    address attacker = address(uint160(uint256(keccak256("someone with no code and no rights"))));

    function setUp() public {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://mainnet.gateway.tenderly.co")), FORK_BLOCK);
        vm.roll(FORK_BLOCK + 1);
        vm.warp(block.timestamp + 12);
        vm.coinbase(builder);
        vm.deal(builder, 0);
        arbC = new StUsdsArbLite(MAIN, keeper);
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

    function _run(uint256 minShares, uint256 maxSpend, uint256 tipBps, uint256 rate, uint256 minNet, uint256 twoStepFrom)
        internal
        returns (uint256)
    {
        vm.prank(keeper);
        return arbC.run(minShares, maxSpend, tipBps, rate, minNet, twoStepFrom, 0);
    }

    /// What the bot does off-chain: the pool's price for a small purchase, a hair under so the run never overbuys.
    function _poolPrice() internal view returns (uint256) {
        (bool ok, bytes memory ret) = CURVE.staticcall(abi.encodeWithSignature("get_dy(int128,int128,uint256)", 0, 1, 100e18));
        require(ok);
        return 100e18 * 1e18 / abi.decode(ret, (uint256)) * 9995 / 10000;
    }

    function _assertHoldsNoTokens() internal view {
        assertEq(usds.balanceOf(address(arbC)), 0, "holds USDS");
        assertEq(st.balanceOf(address(arbC)), 0, "holds stUSDS");
        assertEq(IToken4(DAI).balanceOf(address(arbC)), 0, "holds DAI");
        assertEq(IToken4(USDC).balanceOf(address(arbC)), 0, "holds USDC");
        assertEq(IToken4(CURVE).balanceOf(address(arbC)), 0, "holds pool tokens");
    }

    // ---------- it sizes itself and pays the main wallet ----------

    function test_seesExactlyWhatIsRedeemable() public {
        uint256 start = st.convertToAssets(arbC.available());
        _free(40_000e18);
        assertApproxEqAbs(st.convertToAssets(arbC.available()), start + 40_000e18, 1e18);
    }

    function test_takesWhatIsThereAndPaysTheMainWallet() public {
        _free(40_000e18);
        uint256 avail = arbC.available();
        uint256 before = usds.balanceOf(MAIN);
        uint256 mainShares = st.balanceOf(MAIN);
        uint256 net = _run(1_000e18, NO_CAP, 0, 0, 1_000e18, 5_000e18);
        assertGt(net, 2_000e18);
        assertEq(usds.balanceOf(MAIN) - before, net, "profit not at main wallet");
        assertEq(st.balanceOf(MAIN), mainShares, "touched the main wallet's stUSDS");
        assertLt(arbC.available(), avail / 100, "left more than one percent unused");
        _assertHoldsNoTokens();
        console2.log("40k freed, two-step route: net USDS", net / 1e18, "left unused shares", arbC.available() / 1e18);
    }

    function test_oneSwapRouteAlsoWorksAtSize() public {
        _free(40_000e18);
        uint256 avail = arbC.available();
        uint256 net = _run(1_000e18, NO_CAP, 0, 0, 1_000e18, NEVER);
        assertGt(net, 2_000e18);
        assertLt(arbC.available(), avail / 100, "left more than one percent unused");
        _assertHoldsNoTokens();
        console2.log("40k freed, one swap: net USDS", net / 1e18, "left unused shares", arbC.available() / 1e18);
    }

    function testFuzz_anySizeEndsWithProfitOrNothing(uint256 freed, bool twoStep) public {
        freed = bound(freed, 30e18, 600_000e18);
        _free(freed);
        vm.deal(address(arbC), 0.2 ether);
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        try arbC.run(20e18, 400_000e18, 9900, RATE, 0, twoStep ? 0 : NEVER, 0) returns (uint256 net) {
            assertEq(usds.balanceOf(MAIN) - before, net);
            assertGt(net, 0);
        } catch {
            assertEq(usds.balanceOf(MAIN), before, "a failed run moved money");
            assertEq(address(arbC).balance, 0.2 ether, "a failed run spent tip money");
        }
        _assertHoldsNoTokens();
    }

    function test_smallOpeningUsesLittleGas() public {
        _free(40e18);
        vm.deal(address(arbC), 0.1 ether);
        uint256 price = _poolPrice();
        uint256 avail = arbC.available();
        vm.prank(keeper);
        uint256 g = gasleft();
        uint256 net = arbC.run(20e18, NO_CAP, 9850, RATE, 0, 5_000e18, price);
        g -= gasleft();
        assertGt(net, 2e18);
        assertGt(builder.balance, 0);
        assertLt(arbC.available(), avail / 500, "left more than 0.2% unused");
        // The call itself, before refunds; a transaction adds 21,000 plus calldata. The earlier contract needed
        // about 1,150,000.
        assertLt(g, 350_000, "not lean any more");
        console2.log("40 USDS opening, keeper's price: gas inside the call", g);
        console2.log("  profit to main (USDS, 1e-3)", net / 1e15, "builder wei", builder.balance);
    }

    function test_keepersPriceMatchesAskingThePool() public {
        _free(400e18);
        uint256 price = _poolPrice();
        uint256 snap = vm.snapshotState();
        uint256 asked = _run(100e18, NO_CAP, 0, 0, 0, NEVER);
        vm.revertToState(snap);
        vm.prank(keeper);
        uint256 told = arbC.run(100e18, NO_CAP, 0, 0, 0, NEVER, price);
        assertApproxEqRel(told, asked, 0.002e18, "the two ways of sizing disagree");
    }

    function test_tooHighAPriceRevertsInsteadOfOverbuying() public {
        _free(400e18);
        uint256 price = _poolPrice() * 102 / 100; // would buy 2% more shares than Sky can redeem
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        vm.expectRevert();
        arbC.run(100e18, NO_CAP, 0, 0, 0, NEVER, price);
        assertEq(usds.balanceOf(MAIN), before);
        _assertHoldsNoTokens();
    }

    function test_tooLowAPriceJustLeavesSomeBehind() public {
        _free(400e18);
        uint256 price = _poolPrice() * 90 / 100;
        vm.prank(keeper);
        uint256 net = arbC.run(100e18, NO_CAP, 0, 0, 0, NEVER, price);
        assertGt(net, 20e18);
        assertGt(st.convertToAssets(arbC.available()), 30e18, "a tenth should be left");
        _assertHoldsNoTokens();
    }

    function test_spendingCapIsRespected() public {
        _free(300_000e18);
        uint256 availValue = st.convertToAssets(arbC.available());
        _run(100e18, 50_000e18, 0, 0, 1e18, 5_000e18);
        assertGt(st.convertToAssets(arbC.available()), availValue - 60_000e18);
        _assertHoldsNoTokens();
    }

    function test_fallsBackToTheDaiLoanWhenMorphoIsShort() public {
        _free(40_000e18);
        deal(USDS, MORPHO, 100e18); // Morpho can lend almost nothing
        uint256 before = usds.balanceOf(MAIN);
        uint256 net = _run(1_000e18, NO_CAP, 0, 0, 1_000e18, 5_000e18);
        assertGt(net, 2_000e18);
        assertEq(usds.balanceOf(MAIN) - before, net);
        _assertHoldsNoTokens();
    }

    // ---------- the builder's tip ----------

    function test_builderIsPaidFromTheEthHeld() public {
        _free(400e18);
        vm.deal(address(arbC), 1 ether);
        uint256 snap = vm.snapshotState();
        uint256 profit = _run(100e18, NO_CAP, 0, 0, 0, NEVER);
        vm.revertToState(snap);
        uint256 net = _run(100e18, NO_CAP, 9900, RATE, 0, NEVER);
        // All of the USDS profit reaches the main wallet; the builder's 99% comes out of the ETH held.
        assertEq(net, profit);
        assertEq(builder.balance, profit * 9900 / 10000 * RATE / 1e18, "builder not paid 99% at the keeper's price");
        assertEq(address(arbC).balance, 1 ether - builder.balance);
        _assertHoldsNoTokens();
        console2.log("profit (USDS, 1e-3)", profit / 1e15, "builder wei", builder.balance);
    }

    function test_tipShrinksToKeepTheMinimum() public {
        _free(400e18);
        vm.deal(address(arbC), 1 ether);
        uint256 snap = vm.snapshotState();
        uint256 profit = _run(100e18, NO_CAP, 0, 0, 0, NEVER);
        vm.revertToState(snap);
        _run(100e18, NO_CAP, 9950, RATE, 2e18, NEVER);
        // 99.5% would leave well under 2 USDS, so the tip gives way: its value is the profit less 2 USDS.
        assertEq(builder.balance, (profit - 2e18) * RATE / 1e18);
    }

    function test_whenTheEthHeldIsShortASmallTipJustPaysWhatIsThere() public {
        _free(100e18); // about 9 USDS of profit: the missing part of the tip is under the 10 USDS worth swapping for
        vm.deal(address(arbC), 0.001 ether);
        uint256 before = usds.balanceOf(MAIN);
        uint256 net = _run(50e18, NO_CAP, 9900, RATE, 0, NEVER);
        assertEq(builder.balance, 0.001 ether, "should pay all it holds");
        assertEq(address(arbC).balance, 0);
        assertEq(usds.balanceOf(MAIN) - before, net);
        _assertHoldsNoTokens();
    }

    function test_whenTheEthHeldIsShortALargeTipIsSwappedFromTheProfit() public {
        _free(40_000e18);
        vm.deal(address(arbC), 0.05 ether);
        uint256 snap = vm.snapshotState();
        uint256 profit = _run(1_000e18, NO_CAP, 0, 0, 0, 5_000e18);
        vm.revertToState(snap);
        uint256 net = _run(1_000e18, NO_CAP, 9900, RATE, 0, 5_000e18);
        uint256 want = profit * 9900 / 10000 * RATE / 1e18;
        // The builder gets about the full 99%: 0.05 ETH from what was held, the rest swapped at the market price.
        assertApproxEqRel(builder.balance, want, 0.03e18, "builder not paid about 99%");
        assertEq(address(arbC).balance, 0);
        // The main wallet keeps the 1% plus the value of the 0.05 ETH that did not have to be swapped.
        assertApproxEqRel(net, profit / 100 + 0.05 ether * 1e18 / RATE, 0.03e18);
        _assertHoldsNoTokens();
        console2.log("profit", profit / 1e18, "to main", net / 1e18);
        console2.log("builder wei", builder.balance);
    }

    function test_noEthAndNoRateMeansNoTip() public {
        _free(400e18);
        uint256 net = _run(100e18, NO_CAP, 9900, 0, 0, NEVER);
        assertGt(net, 10e18);
        assertEq(builder.balance, 0);
    }

    // ---------- things that must fail ----------

    function test_nothingRedeemableRevertsAndCostsNothing() public {
        vm.deal(address(arbC), 0.2 ether);
        uint256 before = usds.balanceOf(MAIN);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbLite.TooLittle.selector);
        arbC.run(100e18, NO_CAP, 9900, RATE, 0, NEVER, 0);
        assertEq(usds.balanceOf(MAIN), before);
        assertEq(address(arbC).balance, 0.2 ether);
    }

    function test_belowTheMinimumOpeningReverts() public {
        _free(60e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbLite.TooLittle.selector);
        arbC.run(150e18, NO_CAP, 9900, RATE, 0, NEVER, 0);
    }

    function test_minimumProfitIsEnforced() public {
        _free(40_000e18);
        vm.prank(keeper);
        vm.expectPartialRevert(StUsdsArbLite.Unprofitable.selector);
        arbC.run(1_000e18, NO_CAP, 0, 0, 20_000e18, 5_000e18, 0);
    }

    function test_tipShareAndPriceAreCapped() public {
        _free(40_000e18);
        vm.prank(keeper);
        vm.expectRevert(StUsdsArbLite.BadTipShare.selector);
        arbC.run(1_000e18, NO_CAP, 9996, RATE, 0, NEVER, 0);
        vm.prank(keeper);
        vm.expectRevert(StUsdsArbLite.BadRate.selector);
        arbC.run(1_000e18, NO_CAP, 9900, 2e15 + 1, 0, NEVER, 0);
    }

    function test_onlyKeeperCanRun() public {
        _free(40_000e18);
        vm.prank(attacker);
        vm.expectRevert(StUsdsArbLite.NotKeeper.selector);
        arbC.run(1_000e18, NO_CAP, 0, 0, 0, NEVER, 0);
        vm.prank(MAIN);
        vm.expectRevert(StUsdsArbLite.NotKeeper.selector);
        arbC.run(1_000e18, NO_CAP, 0, 0, 0, NEVER, 0);
    }

    function test_onlyMainWalletCanChangeKeeper() public {
        vm.prank(keeper);
        vm.expectRevert(StUsdsArbLite.NotOwner.selector);
        arbC.setKeeper(attacker);
        vm.prank(MAIN);
        arbC.setKeeper(attacker);
        assertEq(arbC.keeper(), attacker);
    }

    function test_loanCallbacksCannotBeTriggeredByOthers() public {
        _free(40_000e18);
        vm.deal(address(arbC), 1 ether);
        bytes memory data = abi.encode(StUsdsArbLite.Job(1e18, 1e18, 9900, RATE, 0, false));
        vm.startPrank(attacker);
        vm.expectRevert(StUsdsArbLite.BadCallback.selector);
        arbC.onMorphoFlashLoan(1e18, data);
        vm.expectRevert(StUsdsArbLite.BadCallback.selector);
        arbC.onFlashLoan(address(arbC), DAI, 1e18, 0, data);
        // Asking the lenders to call it does not work either: outside a run it refuses.
        vm.expectRevert();
        IFlash4(FLASH).flashLoan(address(arbC), DAI, 1e18, data);
        vm.stopPrank();
        vm.prank(MORPHO);
        vm.expectRevert(StUsdsArbLite.BadCallback.selector);
        arbC.onMorphoFlashLoan(1e18, data);
        assertEq(address(arbC).balance, 1 ether);
    }

    function test_tipMoneyOnlyLeavesToTheMainWallet() public {
        vm.deal(address(arbC), 1 ether);
        vm.prank(attacker);
        vm.expectRevert(StUsdsArbLite.NotOwner.selector);
        arbC.withdrawEth(1 ether);
        uint256 before = MAIN.balance;
        vm.prank(keeper);
        arbC.withdrawEth(0.4 ether);
        vm.prank(MAIN);
        arbC.withdrawEth(0.6 ether);
        assertEq(MAIN.balance - before, 1 ether);
        assertEq(address(arbC).balance, 0);
    }

    function test_anyoneCanAddTipMoney() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok,) = address(arbC).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(arbC).balance, 1 ether);
    }

    function test_donatedTokensEndUpAtMainWallet() public {
        deal(USDC, address(arbC), 5e6);
        deal(USDS, address(arbC), 7e18);
        _free(40_000e18);
        _run(1_000e18, NO_CAP, 0, 0, 0, 5_000e18);
        uint256 usdcBefore = IToken4(USDC).balanceOf(MAIN);
        uint256 usdsBefore = usds.balanceOf(MAIN);
        vm.startPrank(attacker);
        arbC.sweep(USDC);
        arbC.sweep(USDS);
        vm.stopPrank();
        assertEq(IToken4(USDC).balanceOf(MAIN) - usdcBefore, 5e6);
        assertEq(usds.balanceOf(MAIN) - usdsBefore, 7e18);
        _assertHoldsNoTokens();
    }

    function test_standingApprovalsHaveNothingToReach() public {
        // The approvals set at deployment only matter while a run is in progress; between runs there is nothing here.
        _free(40_000e18);
        _run(1_000e18, NO_CAP, 0, 0, 0, 5_000e18);
        _assertHoldsNoTokens();
        assertEq(usds.allowance(MAIN, address(arbC)), 0);
        assertEq(st.allowance(MAIN, address(arbC)), 0);
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

        uint256 net = _run(1_000e18, NO_CAP, 0, 0, 1_000e18, 5_000e18);
        assertGt(net, 2_500e18);
        _assertHoldsNoTokens();
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
            i += (op >= 0x60 && op <= 0x7f) ? uint256(op) - 0x5e : 1;
        }
    }
}
