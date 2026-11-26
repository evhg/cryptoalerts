// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CondProbe} from "../src/CondProbe.sol";

contract CondProbeTest is Test {
    address owner = address(uint160(uint256(keccak256("probe owner"))));
    address keeper = address(uint160(uint256(keccak256("probe keeper"))));
    address setter = address(uint160(uint256(keccak256("probe setter"))));
    address builder = address(uint160(uint256(keccak256("probe builder"))));
    CondProbe p;

    function setUp() public {
        p = new CondProbe{value: 0.002 ether}(owner, keeper, setter);
        vm.coinbase(builder);
    }

    function test_claimOnlyWorksInTheBlockOfTheSet() public {
        vm.prank(keeper);
        vm.expectRevert("not set in this block");
        p.claim(1e14);
        vm.prank(setter);
        p.set();
        vm.prank(keeper);
        p.claim(1e14);
        assertEq(builder.balance, 1e14);
        assertEq(p.flag(), 0);
        vm.prank(keeper);
        vm.expectRevert("not set in this block");
        p.claim(1e14); // once per set
        vm.prank(setter);
        p.set();
        vm.roll(block.number + 1);
        vm.prank(keeper);
        vm.expectRevert("not set in this block");
        p.claim(1e14); // a block late is too late
    }

    function test_onlyTheNamedAccountsAndCappedTip() public {
        vm.expectRevert("not setter");
        p.set();
        vm.prank(setter);
        p.set();
        vm.expectRevert("not keeper");
        p.claim(1);
        vm.prank(keeper);
        p.claim(1 ether);
        assertEq(builder.balance, 0.001 ether, "tip is capped");
        vm.expectRevert("not allowed");
        p.withdraw();
        vm.prank(keeper);
        p.withdraw();
        assertEq(owner.balance, 0.001 ether, "the rest goes to the owner");
    }
}
