// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LaunchToken} from "../src/LaunchToken.sol";

contract LaunchTokenTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000 * 1e18;

    LaunchToken internal token;
    address internal deployer = makeAddr("deployer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.prank(deployer);
        token = new LaunchToken();
    }

    function test_metadata() public view {
        assertEq(token.name(), "Taskboard");
        assertEq(token.symbol(), "TASK");
        assertEq(token.decimals(), 18);
    }

    function test_mintsFixedSupplyToDeployer() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.totalSupply(), 1e27);
        assertEq(token.balanceOf(deployer), SUPPLY);
    }

    function test_constructorEmitsTransferFromZero() public {
        vm.expectEmit(true, true, true, true);
        emit LaunchToken.Transfer(address(0), alice, SUPPLY);
        vm.prank(alice);
        new LaunchToken();
    }

    function test_transfer() public {
        vm.expectEmit(true, true, true, true);
        emit LaunchToken.Transfer(deployer, alice, 1e18);
        vm.prank(deployer);
        assertTrue(token.transfer(alice, 1e18));
        assertEq(token.balanceOf(alice), 1e18);
        assertEq(token.balanceOf(deployer), SUPPLY - 1e18);
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_transferRevertsOnInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(LaunchToken.InsufficientBalance.selector);
        token.transfer(bob, 1);
    }

    function test_transferRevertsToZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(LaunchToken.ZeroAddress.selector);
        token.transfer(address(0), 1);
    }

    function test_approveAndTransferFrom() public {
        vm.prank(deployer);
        assertTrue(token.approve(alice, 5e18));
        assertEq(token.allowance(deployer, alice), 5e18);

        vm.prank(alice);
        assertTrue(token.transferFrom(deployer, bob, 2e18));
        assertEq(token.balanceOf(bob), 2e18);
        assertEq(token.allowance(deployer, alice), 3e18);
    }

    function test_transferFromRevertsBeyondAllowance() public {
        vm.prank(deployer);
        token.approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(LaunchToken.InsufficientAllowance.selector);
        token.transferFrom(deployer, bob, 1e18 + 1);
    }

    function test_infiniteAllowanceIsNotDecremented() public {
        vm.prank(deployer);
        token.approve(alice, type(uint256).max);
        vm.prank(alice);
        token.transferFrom(deployer, bob, 1e18);
        assertEq(token.allowance(deployer, alice), type(uint256).max);
    }

    function test_noMintOrAdminSelectors() public {
        string[6] memory sigs = [
            "mint(address,uint256)",
            "mint(uint256)",
            "burn(uint256)",
            "transferOwnership(address)",
            "owner()",
            "pause()"
        ];
        for (uint256 i; i < sigs.length; ++i) {
            (bool ok,) = address(token).call(abi.encodeWithSignature(sigs[i], alice, uint256(1)));
            assertFalse(ok, sigs[i]);
        }
        assertEq(token.totalSupply(), SUPPLY);
    }

    function testFuzz_transferConservesSupply(uint256 amount) public {
        amount = bound(amount, 0, SUPPLY);
        vm.prank(deployer);
        token.transfer(alice, amount);
        assertEq(token.balanceOf(alice) + token.balanceOf(deployer), SUPPLY);
    }
}
