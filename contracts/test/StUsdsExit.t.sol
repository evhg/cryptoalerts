// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";
import {StUsdsExit} from "../src/StUsdsExit.sol";

interface IStUsds {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function convertToAssets(uint256) external view returns (uint256);
    function maxWithdraw(address) external view returns (uint256);
    function maxRedeem(address) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function totalAssets() external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// A block builder address that refuses ETH.
contract RejectingCoinbase {
    receive() external payable {
        revert("no thanks");
    }
}

/// A hostile block builder that tries to call back into the exit contract.
contract ReentrantCoinbase {
    StUsdsExit public target;
    bool public reentryBlocked;

    function aim(StUsdsExit t) external {
        target = t;
    }

    receive() external payable {
        try target.exit(type(uint256).max, 0) {}
        catch {
            reentryBlocked = true;
        }
    }
}

/// A hostile block builder that burns all the gas it is given and returns a huge blob.
contract GasBurningCoinbase {
    receive() external payable {
        uint256 i;
        while (true) {
            i++;
        }
    }
}

contract ReturnBombCoinbase {
    receive() external payable {
        assembly {
            return(0, 40000)
        }
    }
}

/// Fork tests against real mainnet state around the liquidity event of
/// 2026-11-23: a 3,000,000 USDS repayment landed in block 26477749 and the
/// freed liquidity was withdrawn by others in block 26477750.
contract StUsdsExitTest is Test {
    address constant ST_USDS = 0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9;
    address constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address constant OWNER = 0xCD532243888D26791881064E24D4A25FD0041d98;

    uint256 constant ALERT_BLOCK = 26477749; // 2.09M USDS withdrawable at its end
    uint256 constant NEXT_BLOCK = 26477750; // 16.6K left at its end
    uint256 constant DRY_BLOCK = 26477753; // nothing withdrawable

    // About $100 of ETH (at ~$1,720) for a full exit of ~1.275M USDS.
    uint256 constant TIP_WEI_PER_USDS = 46_000_000_000; // 4.6e10 wei per USDS
    uint256 constant MAX_TIP = 0.06 ether;
    uint256 constant FLOOR = 100e18;

    IStUsds st = IStUsds(ST_USDS);
    IERC20 usds = IERC20(USDS);
    address keeper = makeAddr("keeper");
    address builder = makeAddr("builder");
    StUsdsExit exitC;

    function _fork(uint256 blockNumber) internal {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://mainnet.gateway.tenderly.co")), blockNumber);
        // Act as a transaction in the following block.
        vm.roll(blockNumber + 1);
        vm.warp(block.timestamp + 12);
        vm.coinbase(builder);
        exitC = new StUsdsExit(ST_USDS, OWNER, keeper, FLOOR, TIP_WEI_PER_USDS, MAX_TIP);
        // Forge's default deployment addresses hold stray dust on mainnet; start clean.
        vm.deal(address(exitC), 0);
        vm.deal(builder, 0);
        vm.deal(keeper, 1 ether);
    }

    function _approveAll() internal {
        vm.prank(OWNER);
        st.approve(address(exitC), type(uint256).max);
    }

    // ---------- replay of the real event ----------

    function test_replay_fullExitInTheBlockAfterTheAlert() public {
        _fork(ALERT_BLOCK);
        _approveAll();

        uint256 sharesBefore = st.balanceOf(OWNER);
        uint256 worth = st.convertToAssets(sharesBefore);
        uint256 usdsBefore = usds.balanceOf(OWNER);
        assertGt(st.maxWithdraw(OWNER), 1_000_000e18, "liquidity should cover the position");

        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 1_000_000e18);
        uint256 gasUsed = gasBefore - gasleft();

        assertEq(st.balanceOf(OWNER), 0, "all shares redeemed");
        assertEq(usds.balanceOf(OWNER) - usdsBefore, assets, "USDS went to the owner");
        assertApproxEqAbs(assets, worth, 1e12, "received the full value");
        assertEq(usds.balanceOf(address(exitC)), 0, "contract holds nothing");
        assertEq(st.balanceOf(address(exitC)), 0, "contract holds nothing");

        uint256 expectedTip = (assets * TIP_WEI_PER_USDS) / 1e18;
        if (expectedTip > MAX_TIP) expectedTip = MAX_TIP;
        assertEq(builder.balance, expectedTip, "builder tip");
        assertEq(keeper.balance, 1 ether - expectedTip, "rest refunded to keeper");
        assertEq(address(exitC).balance, 0, "no ETH left behind");

        console2.log("shares redeemed      ", sharesBefore / 1e18);
        console2.log("USDS received        ", assets / 1e18);
        console2.log("tip paid (gwei)      ", expectedTip / 1e9);
        console2.log("gas used by exit call", gasUsed);
    }

    function test_replay_partialFillOneBlockLater() public {
        _fork(NEXT_BLOCK);
        _approveAll();

        uint256 sharesBefore = st.balanceOf(OWNER);
        uint256 available = st.maxWithdraw(OWNER);
        assertGt(available, 10_000e18);
        assertLt(available, 20_000e18);

        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);

        assertApproxEqAbs(assets, available, 1e12, "took what was there");
        assertGt(st.balanceOf(OWNER), 0, "rest of the position untouched");
        assertLt(st.balanceOf(OWNER), sharesBefore);
        // Tip scales with the amount actually redeemed: ~16.6K USDS, not 1.27M.
        uint256 tip = builder.balance;
        assertEq(tip, (assets * TIP_WEI_PER_USDS) / 1e18);
        assertLt(tip, MAX_TIP / 50);
        console2.log("partial USDS received", assets / 1e18);
        console2.log("partial tip (gwei)   ", tip / 1e9);
    }

    function test_replay_nothingAvailableReverts() public {
        _fork(DRY_BLOCK);
        _approveAll();
        uint256 sharesBefore = st.balanceOf(OWNER);

        vm.prank(keeper);
        vm.expectRevert();
        exitC.exit{value: MAX_TIP}(type(uint256).max, 0);

        assertEq(st.balanceOf(OWNER), sharesBefore);
        assertEq(keeper.balance, 1 ether, "a failed attempt costs no tip");
    }

    // ---------- who can do what ----------

    function test_onlyKeeperOrOwnerCanExit() public {
        _fork(ALERT_BLOCK);
        _approveAll();

        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(StUsdsExit.NotAuthorized.selector);
        exitC.exit{value: 0.01 ether}(type(uint256).max, 0);

        // The owner can always trigger it themselves.
        vm.prank(OWNER);
        uint256 assets = exitC.exit(type(uint256).max, 0);
        assertGt(assets, 1_000_000e18);
    }

    function test_onlyOwnerCanConfigure() public {
        _fork(DRY_BLOCK);
        vm.prank(keeper);
        vm.expectRevert(StUsdsExit.NotAuthorized.selector);
        exitC.configure(keeper, 0, type(uint256).max, type(uint256).max);

        vm.prank(OWNER);
        exitC.configure(address(0xBEEF), 5e18, 1, 2);
        assertEq(exitC.keeper(), address(0xBEEF));
        assertEq(exitC.minAssetsFloor(), 5e18);
        assertEq(exitC.tipWeiPerUsds(), 1);
        assertEq(exitC.maxTipWei(), 2);
    }

    function test_withoutApprovalNothingMoves() public {
        _fork(ALERT_BLOCK);
        uint256 sharesBefore = st.balanceOf(OWNER);
        vm.prank(keeper);
        vm.expectRevert(StUsdsExit.NothingToRedeem.selector);
        exitC.exit(type(uint256).max, 0);
        assertEq(st.balanceOf(OWNER), sharesBefore);
    }

    function test_allowanceBoundsTheRedemption() public {
        _fork(ALERT_BLOCK);
        vm.prank(OWNER);
        st.approve(address(exitC), 1_000e18);
        uint256 sharesBefore = st.balanceOf(OWNER);

        vm.prank(keeper);
        exitC.exit(type(uint256).max, 0);
        assertEq(sharesBefore - st.balanceOf(OWNER), 1_000e18, "only the approved shares");

        // Allowance is used up: a second call has nothing to work with.
        vm.prank(keeper);
        vm.expectRevert(StUsdsExit.NothingToRedeem.selector);
        exitC.exit(type(uint256).max, 0);
    }

    function test_maxSharesBoundsTheRedemption() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        uint256 sharesBefore = st.balanceOf(OWNER);
        vm.prank(keeper);
        exitC.exit(50_000e18, 0);
        assertEq(sharesBefore - st.balanceOf(OWNER), 50_000e18);
    }

    // ---------- hostile conditions ----------

    function test_dustBaitIsRefused() public {
        // Someone leaves a few USDS of liquidity to lure the bot into paying a tip.
        _fork(DRY_BLOCK);
        _approveAll();
        address baiter = makeAddr("baiter");
        deal(USDS, baiter, 50e18);
        vm.startPrank(baiter);
        usds.approve(ST_USDS, 50e18);
        st.deposit(50e18, baiter);
        vm.stopPrank();
        assertGt(st.maxWithdraw(OWNER), 40e18, "bait liquidity is visible");

        uint256 sharesBefore = st.balanceOf(OWNER);
        vm.prank(keeper);
        vm.expectRevert(); // BelowMinimum: under the owner's 100 USDS floor
        exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertEq(st.balanceOf(OWNER), sharesBefore);
        assertEq(builder.balance, 0);
        assertEq(keeper.balance, 1 ether);
    }

    function test_keeperMinimumIsEnforced() public {
        _fork(NEXT_BLOCK); // only ~16.6K available
        _approveAll();
        vm.prank(keeper);
        vm.expectRevert();
        exitC.exit{value: MAX_TIP}(type(uint256).max, 100_000e18);
        assertEq(builder.balance, 0);
    }

    function test_overOfferedTipIsCappedAndRefunded() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        vm.deal(keeper, 10 ether);
        vm.prank(keeper);
        exitC.exit{value: 10 ether}(type(uint256).max, 0);
        assertLe(builder.balance, MAX_TIP);
        assertEq(keeper.balance, 10 ether - builder.balance);
    }

    function test_stolenKeeperKeyCanOnlyPayTheOwner() public {
        // The worst a thief with the keeper key can do is run the exit: every
        // USDS still lands in the owner's wallet and the tip stays capped.
        _fork(ALERT_BLOCK);
        _approveAll();
        uint256 usdsBefore = usds.balanceOf(OWNER);
        vm.deal(keeper, 5 ether);
        vm.prank(keeper);
        uint256 assets = exitC.exit{value: 5 ether}(type(uint256).max, 0);
        assertEq(usds.balanceOf(OWNER) - usdsBefore, assets);
        assertEq(usds.balanceOf(keeper), 0);
        assertLe(builder.balance, MAX_TIP);
    }

    function test_builderThatRejectsEthStillLetsTheExitThrough() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        RejectingCoinbase rc = new RejectingCoinbase();
        vm.deal(address(rc), 0);
        vm.coinbase(address(rc));
        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertGt(assets, 1_000_000e18);
        assertEq(address(rc).balance, 0);
        assertEq(keeper.balance, 1 ether, "whole tip refunded");
    }

    function test_reentrantBuilderGetsNowhere() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        ReentrantCoinbase rc = new ReentrantCoinbase();
        rc.aim(exitC);
        vm.deal(address(rc), 0);
        vm.coinbase(address(rc));
        uint256 usdsBefore = usds.balanceOf(OWNER);
        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertTrue(rc.reentryBlocked(), "re-entry was attempted and refused");
        assertEq(usds.balanceOf(OWNER) - usdsBefore, assets);
        assertEq(st.balanceOf(OWNER), 0);
    }

    function test_gasBurningBuilderCannotBlockOrDrainTheExit() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        GasBurningCoinbase gb = new GasBurningCoinbase();
        vm.deal(address(gb), 0);
        vm.coinbase(address(gb));
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        uint256 assets = exitC.exit{gas: 500_000, value: MAX_TIP}(type(uint256).max, 0);
        uint256 gasUsed = gasBefore - gasleft();
        assertGt(assets, 1_000_000e18, "exit still completes");
        assertEq(st.balanceOf(OWNER), 0);
        assertEq(address(gb).balance, 0, "a builder that misbehaves gets no tip");
        assertEq(keeper.balance, 1 ether, "tip refunded");
        assertLt(gasUsed, 330_000, "its gas burn is bounded by the fixed allowance");
    }

    function test_returnBombFromBuilderIsHarmless() public {
        _fork(ALERT_BLOCK);
        _approveAll();
        ReturnBombCoinbase rb = new ReturnBombCoinbase();
        vm.deal(address(rb), 0);
        vm.coinbase(address(rb));
        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        exitC.exit{gas: 500_000, value: MAX_TIP}(type(uint256).max, 0);
        assertLt(gasBefore - gasleft(), 330_000);
        assertEq(st.balanceOf(OWNER), 0);
    }

    function test_frontRunnerTakingTheLiquidityOnlyMakesUsRevert() public {
        // A competitor drains the pool first. Our call reverts, so sent as a
        // bundle it is simply not included; nothing of the owner's moves.
        _fork(ALERT_BLOCK);
        _approveAll();
        address whale = makeAddr("whale"); // a competitor holding a large position
        deal(ST_USDS, whale, 3_000_000e18);
        vm.startPrank(whale);
        (bool ok,) = ST_USDS.call(abi.encodeWithSignature("withdraw(uint256,address,address)", st.maxWithdraw(whale), whale, whale));
        vm.stopPrank();
        assertTrue(ok, "competitor emptied the pool");
        assertLt(st.maxWithdraw(OWNER), 1e18);

        uint256 sharesBefore = st.balanceOf(OWNER);
        vm.prank(keeper);
        vm.expectRevert();
        exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertEq(st.balanceOf(OWNER), sharesBefore);
        assertEq(builder.balance, 0);
        assertEq(keeper.balance, 1 ether);
    }

    function test_sandwichAroundTheExitChangesNothingForTheOwner() public {
        // Deposit just before us and withdraw just after: a redemption has no
        // price to move, so the owner receives exactly the position's value.
        _fork(ALERT_BLOCK);
        _approveAll();
        uint256 worth = st.convertToAssets(st.balanceOf(OWNER));
        address attacker = makeAddr("attacker");
        deal(USDS, attacker, 5_000_000e18);
        vm.startPrank(attacker);
        usds.approve(ST_USDS, 5_000_000e18);
        st.deposit(5_000_000e18, attacker);
        vm.stopPrank();

        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertApproxEqAbs(assets, worth, 1e12);

        vm.startPrank(attacker);
        (bool ok,) = ST_USDS.call(abi.encodeWithSignature("redeem(uint256,address,address)", st.maxRedeem(attacker), attacker, attacker));
        vm.stopPrank();
        assertTrue(ok);
        assertLe(usds.balanceOf(attacker), 5_000_000e18 + 1e18, "and the attacker gained nothing");
    }

    function test_tokensAndEthSentToTheContractGiveNoLeverage() public {
        // Griefers can donate shares or force ETH in; neither changes what the
        // owner receives, and the contract has no way to move either out.
        _fork(ALERT_BLOCK);
        _approveAll();
        deal(ST_USDS, address(exitC), 1_000e18);
        vm.deal(address(exitC), 3 ether);
        uint256 worth = st.convertToAssets(st.balanceOf(OWNER));
        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        assertApproxEqAbs(assets, worth, 1e12);
        assertEq(st.balanceOf(address(exitC)), 1_000e18, "donated shares untouched");
        assertEq(address(exitC).balance, 3 ether, "forced ETH is never paid out as a tip");
        assertLe(builder.balance, MAX_TIP);
    }

    function test_noSelectorMovesFundsAnywhereButTheOwner() public {
        // Throw every plausible "transfer-like" call at the contract as the keeper.
        _fork(ALERT_BLOCK);
        _approveAll();
        bytes[6] memory calls = [
            abi.encodeWithSignature("transfer(address,uint256)", keeper, 1e18),
            abi.encodeWithSignature("transferFrom(address,address,uint256)", OWNER, keeper, 1e18),
            abi.encodeWithSignature("redeem(uint256,address,address)", 1e18, keeper, OWNER),
            abi.encodeWithSignature("withdraw(uint256,address,address)", 1e18, keeper, OWNER),
            abi.encodeWithSignature("sweep(address)", keeper),
            abi.encodeWithSignature("execute(address,bytes)", ST_USDS, abi.encodeWithSignature("transferFrom(address,address,uint256)", OWNER, keeper, 1e18))
        ];
        uint256 sharesBefore = st.balanceOf(OWNER);
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(keeper);
            (bool ok,) = address(exitC).call(calls[i]);
            assertFalse(ok, "unknown selector must revert");
        }
        assertEq(st.balanceOf(OWNER), sharesBefore);
        assertEq(st.balanceOf(keeper), 0);
        assertEq(usds.balanceOf(keeper), 0);
    }

    // ---------- Sky only, exactly what is available ----------

    /// Records every account the exit contract touches during a real exit and
    /// proves the only contract it talks to is Sky's stUSDS (plus paying the
    /// builder tip and refunding the keeper). No DEX, router or aggregator.
    function test_onlyEverCallsSkyStUsds() public {
        _fork(NEXT_BLOCK); // partial liquidity, the realistic case
        _approveAll();
        vm.startStateDiffRecording();
        vm.prank(keeper);
        exitC.exit{value: MAX_TIP}(type(uint256).max, 0);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        // stUSDS is an ERC-1967 proxy; its own forwarding to its implementation
        // shows up with our contract as msg.sender. That hop is still Sky.
        address stUsdsImpl = address(uint160(uint256(vm.load(ST_USDS, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc))));
        uint256 stUsdsCalls;
        for (uint256 i = 0; i < accesses.length; i++) {
            Vm.AccountAccess memory a = accesses[i];
            if (a.accessor != address(exitC)) continue;
            bool isCall = a.kind == VmSafe.AccountAccessKind.Call || a.kind == VmSafe.AccountAccessKind.StaticCall
                || a.kind == VmSafe.AccountAccessKind.DelegateCall || a.kind == VmSafe.AccountAccessKind.CallCode
                || a.kind == VmSafe.AccountAccessKind.Create;
            if (!isCall) continue;
            if (a.account == ST_USDS || (a.account == stUsdsImpl && a.kind == VmSafe.AccountAccessKind.DelegateCall)) {
                stUsdsCalls++;
                continue;
            }
            // Plain ETH transfers only: the builder tip and the keeper refund.
            assertTrue(a.account == builder || a.account == keeper, "exit contract called something other than stUSDS");
            assertEq(a.data.length, 0, "ETH transfers carry no calldata");
            assertTrue(a.kind == VmSafe.AccountAccessKind.Call, "no delegatecall or create");
        }
        assertGt(stUsdsCalls, 0);
    }

    /// The contract's own code has no opcode that could hand control to other
    /// code or create contracts: no DELEGATECALL, CALLCODE, CREATE, CREATE2 or
    /// SELFDESTRUCT. Its only outward calls are the three to stUSDS plus the
    /// two plain ETH transfers checked above.
    function test_bytecodeHasNoDelegatecallCreateOrSelfdestruct() public {
        _fork(DRY_BLOCK);
        bytes memory code = address(exitC).code;
        assertGt(code.length, 0);
        uint256 calls;
        for (uint256 i = 0; i < code.length; i++) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                i += op - 0x5f; // skip PUSH data
                continue;
            }
            assertTrue(op != 0xf4 && op != 0xf2 && op != 0xf0 && op != 0xf5 && op != 0xff, "forbidden opcode");
            if (op == 0xf1) calls++;
        }
        // CALL sites: stUSDS.redeem, builder tip, keeper refund (views use STATICCALL).
        assertEq(calls, 3, "exactly three CALL sites");
    }

    /// The redemption takes exactly what Sky reports as withdrawable for this
    /// owner, at the vault's own share price: never more, and no slippage.
    function test_takesExactlyWhatSkyHasAvailable() public {
        _fork(NEXT_BLOCK);
        _approveAll();
        uint256 available = st.maxWithdraw(OWNER); // Sky's own figure
        uint256 sharesBefore = st.balanceOf(OWNER);
        vm.prank(keeper);
        uint256 assets = exitC.exit(type(uint256).max, 0);
        uint256 sharesBurned = sharesBefore - st.balanceOf(OWNER);
        assertLe(assets, available, "never more than Sky has available");
        assertApproxEqAbs(assets, available, 1e12, "and all of it (within rounding of a millionth of a cent)");
        assertApproxEqAbs(assets, st.convertToAssets(sharesBurned), 1e12, "no slippage: NAV price");
        assertLt(st.maxWithdraw(OWNER), 1e12, "nothing left that Sky would pay out");
    }

    // ---------- arbitrary liquidity ----------

    /// Liquidity of any size appears (here via a deposit); the exit takes
    /// min(liquidity, position) and never reverts for rounding reasons.
    function testFuzz_takesWhatLiquidityAllows(uint256 liquidity) public {
        liquidity = bound(liquidity, 200e18, 3_000_000e18);
        _fork(DRY_BLOCK);
        _approveAll();

        address depositor = makeAddr("depositor");
        deal(USDS, depositor, liquidity);
        vm.startPrank(depositor);
        usds.approve(ST_USDS, liquidity);
        st.deposit(liquidity, depositor);
        vm.stopPrank();

        uint256 worth = st.convertToAssets(st.balanceOf(OWNER));
        uint256 expected = st.maxWithdraw(OWNER);
        uint256 usdsBefore = usds.balanceOf(OWNER);

        vm.prank(keeper);
        uint256 assets = exitC.exit{value: MAX_TIP}(type(uint256).max, 0);

        assertEq(usds.balanceOf(OWNER) - usdsBefore, assets);
        assertApproxEqAbs(assets, expected, 1e12);
        assertLe(assets, worth + 1e12);
        if (liquidity > worth + 1e18) assertEq(st.balanceOf(OWNER), 0, "full exit when liquidity covers it");
        assertLe(builder.balance, MAX_TIP);
        assertEq(address(exitC).balance, 0);
    }
}
