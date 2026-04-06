/**
 * @file    commands.test.ts
 * @purpose Tests for the bot command modularization (Track 3).
 *          Validates command registration, handler signatures, and
 *          the router aggregation.
 * @author  Will / Antigravity
 * @created 2026-03-20
 * @updated 2026-03-20
 * @deps    vitest
 */

import { describe, it, expect } from 'vitest';
import { allCommands, registerAllCommands } from './index';
import type { BotCommand, BotDeps } from './types';
import { statusCommands } from './status';
import { inventoryCommands } from './inventory';
import { operationsCommands } from './operations';
import { memoryCommands } from './memory-cmds';
import { kaizenCommands } from './kaizen';

describe('Bot Command Modularization', () => {
    describe('allCommands aggregation', () => {
        it('should contain all commands from every module', () => {
            const expected =
                statusCommands.length +
                inventoryCommands.length +
                operationsCommands.length +
                memoryCommands.length +
                kaizenCommands.length;

            expect(allCommands.length).toBe(expected);
            expect(allCommands.length).toBeGreaterThanOrEqual(15);
        });

        it('should include commands from each category', () => {
            const names = allCommands.flatMap(c =>
                Array.isArray(c.name) ? c.name : [c.name]
            );

            // Status commands
            expect(names).toContain('status');
            expect(names).toContain('clear');
            expect(names).toContain('memory');
            expect(names).toContain('crons');

            // Inventory commands
            expect(names).toContain('product');
            expect(names).toContain('receivings');
            expect(names).toContain('consumption');
            expect(names).toContain('simulate');
            expect(names).toContain('build');
            expect(names).toContain('builds');

            // Operations commands
            expect(names).toContain('buildrisk');
            expect(names).toContain('requests');
            expect(names).toContain('requestcomplete');
            expect(names).toContain('alerts');
            expect(names).toContain('correlate');
            expect(names).toContain('notify');

            // Memory commands
            expect(names).toContain('remember');
            expect(names).toContain('recall');
            expect(names).toContain('seed');
            expect(names).toContain('populate');

            // Kaizen commands
            expect(names).toContain('kaizen');
            expect(names).toContain('vendor');
            expect(names).toContain('housekeeping');
            expect(names).toContain('voice');
        });
    });

    describe('BotCommand interface', () => {
        it('should have a name (string or string[]) for every command', () => {
            for (const cmd of allCommands) {
                if (Array.isArray(cmd.name)) {
                    expect(cmd.name.length).toBeGreaterThan(0);
                    for (const n of cmd.name) {
                        expect(typeof n).toBe('string');
                        expect(n.length).toBeGreaterThan(0);
                    }
                } else {
                    expect(typeof cmd.name).toBe('string');
                    expect(cmd.name.length).toBeGreaterThan(0);
                }
            }
        });

        it('should have a description for every command', () => {
            for (const cmd of allCommands) {
                expect(typeof cmd.description).toBe('string');
                expect(cmd.description.length).toBeGreaterThan(0);
            }
        });

        it('should have an async handler function for every command', () => {
            for (const cmd of allCommands) {
                expect(typeof cmd.handler).toBe('function');
            }
        });

        it('should not have duplicate command names', () => {
            const allNames = allCommands.flatMap(c =>
                Array.isArray(c.name) ? c.name : [c.name]
            );
            const unique = new Set(allNames);
            expect(unique.size).toBe(allNames.length);
        });
    });

    describe('registerAllCommands', () => {
        it('should register all commands on the bot', () => {
            const registeredCommands: [string[], Function][] = [];

            // Minimal mock bot — we just need bot.command() to capture registrations
            const mockBot = {
                command: (names: string[], handler: Function) => {
                    registeredCommands.push([names, handler]);
                },
            } as any;

            const mockDeps = {} as BotDeps;

            registerAllCommands(mockBot, mockDeps);

            expect(registeredCommands.length).toBe(allCommands.length);

            // Verify each command name was registered
            const registeredNames = registeredCommands.flatMap(([names]) => names);
            for (const cmd of allCommands) {
                const cmdNames = Array.isArray(cmd.name) ? cmd.name : [cmd.name];
                for (const n of cmdNames) {
                    expect(registeredNames).toContain(n);
                }
            }
        });
    });

    describe('Module exports', () => {
        it('status module should export exactly 4 commands', () => {
            expect(statusCommands.length).toBe(4);
        });

        it('inventory module should export exactly 5 commands', () => {
            expect(inventoryCommands.length).toBe(5);
        });

        it('operations module should export exactly 6 commands', () => {
            expect(operationsCommands.length).toBe(6);
        });

        it('memory module should export exactly 4 commands', () => {
            expect(memoryCommands.length).toBe(4);
        });

        it('kaizen module should export exactly 4 commands', () => {
            expect(kaizenCommands.length).toBe(4);
        });
    });
});
