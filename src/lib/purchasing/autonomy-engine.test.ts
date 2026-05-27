/**
 * @file    autonomy-engine.test.ts
 * @purpose Unit tests for autoProcessAutonomyDrafts purchasing automation logic
 * @author  Will / Antigravity
 * @created 2026-05-27
 * @updated 2026-05-27
 * @deps    vitest, autonomy-engine, po-sender
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoProcessAutonomyDrafts } from './autonomy-engine';
import * as poSender from './po-sender';

const mockGetRecentPurchaseOrders = vi.fn();
const mockGetDraftPOForReview = vi.fn();
const mockCommitDraftPO = vi.fn();
const mockGmailList = vi.fn();

// Mock dependencies
vi.mock('../supabase', () => ({
    createClient: vi.fn(() => ({
        from: vi.fn(() => ({
            select: vi.fn(() => ({
                eq: vi.fn(() => ({
                    eq: vi.fn(() => ({
                        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
                    })),
                })),
            })),
            insert: vi.fn().mockResolvedValue({ data: {} }),
            upsert: vi.fn().mockResolvedValue({ data: {} }),
        })),
    })),
}));

vi.mock('../finale/client', () => {
    class MockFinaleClient {
        getRecentPurchaseOrders = mockGetRecentPurchaseOrders;
        getDraftPOForReview = mockGetDraftPOForReview;
        commitDraftPO = mockCommitDraftPO;
    }
    return {
        FinaleClient: MockFinaleClient,
    };
});

vi.mock('@googleapis/gmail', () => ({
    gmail: vi.fn(() => ({
        users: {
            messages: {
                list: mockGmailList,
            },
        },
    })),
}));

vi.mock('../gmail/auth', () => ({
    getAuthenticatedClient: vi.fn().mockResolvedValue({}),
}));

vi.mock('./po-sender', () => ({
    storePendingPOSend: vi.fn().mockResolvedValue('session-abc'),
    commitAndSendPO: vi.fn().mockResolvedValue({ orderId: 'PO-1002', sentTo: 'test@example.com' }),
    getVendorAutonomyLevel: vi.fn(),
    lookupVendorOrderEmail: vi.fn(),
}));

describe('autoProcessAutonomyDrafts', () => {
    let mockBot: any;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.TELEGRAM_CHAT_ID = '12345';
        mockBot = {
            telegram: {
                sendMessage: vi.fn().mockResolvedValue({ message_id: 99 }),
            },
        };

        mockGetRecentPurchaseOrders.mockResolvedValue([
            { orderId: 'PO-1001', vendorName: 'Rootwise Soil Dynamics', status: 'Created' },
            { orderId: 'PO-1002', vendorName: 'Sustainable Village', status: 'Created' },
        ]);

        mockGetDraftPOForReview.mockResolvedValue({
            orderId: 'PO-1001',
            vendorName: 'Rootwise Soil Dynamics',
            vendorPartyId: 'party-rootwise',
            total: 1725.00,
            items: [{ productId: 'RWBP104', productName: 'Rootwise', quantity: 15, unitPrice: 115.00, lineTotal: 1725.00 }],
        });

        // Default: no matching emails found in Gmail search
        mockGmailList.mockResolvedValue({ data: { messages: [] } });
    });

    it('should ignore vendors at autonomy level 0', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(0); // Manual

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(0);
        expect(mockBot.telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('should generate inline review keyboards for Level 1 autonomy vendors', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(1); // Auto-Draft review
        vi.mocked(poSender.lookupVendorOrderEmail).mockResolvedValue({ email: 'sales@rootwise.com', source: 'vendor_profiles' });

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(2); // processed both drafts
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
            '12345',
            expect.stringContaining('Level 1'),
            expect.objectContaining({
                reply_markup: expect.objectContaining({
                    inline_keyboard: expect.any(Array),
                }),
            })
        );
    });

    it('should autonomously commit and email POs via fallback for Level 2 vendors', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(2); // Auto-Commit & Send
        vi.mocked(poSender.lookupVendorOrderEmail).mockResolvedValue({ email: 'orders@sustainable.com', source: 'vendor_profiles' });

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(2);
        expect(poSender.commitAndSendPO).toHaveBeenCalled();
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
            '12345',
            expect.stringContaining('Level 2'),
            expect.any(Object)
        );
    });

    it('should alert on Telegram if vendor order email is missing', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(2);
        vi.mocked(poSender.lookupVendorOrderEmail).mockResolvedValue({ email: null, source: 'unknown' }); // No email

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(0);
        expect(result.errors).toBe(2);
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
            '12345',
            expect.stringContaining('No order contact email'),
            expect.any(Object)
        );
    });

    it('should automatically mark PO as sent and skip dispatch if Gmail search proves it was already sent manually', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(2);
        vi.mocked(poSender.lookupVendorOrderEmail).mockResolvedValue({ email: 'sales@rootwise.com', source: 'vendor_profiles' });
        
        // Gmail list mock returns a matching sent message
        mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg-123' }] } });

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(2); // Auto-marked both
        expect(mockCommitDraftPO).toHaveBeenCalledTimes(2); // Both committed in Finale!
        expect(poSender.commitAndSendPO).not.toHaveBeenCalled(); // Safe check: didn't send again!
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
            '12345',
            expect.stringContaining('Already manually sent'),
            expect.any(Object)
        );
    });

    it('should automatically mark PO as sent and commit in Finale even for Level 0 (manual) vendors', async () => {
        vi.mocked(poSender.getVendorAutonomyLevel).mockResolvedValue(0); // Level 0 Manual
        
        // Gmail list mock returns a matching sent message
        mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg-123' }] } });

        const result = await autoProcessAutonomyDrafts(mockBot);

        expect(result.processed).toBe(2); // Auto-marked and status-healed both
        expect(mockCommitDraftPO).toHaveBeenCalledTimes(2); // Both committed in Finale!
        expect(poSender.commitAndSendPO).not.toHaveBeenCalled(); // No automatic sending triggered
        expect(mockBot.telegram.sendMessage).toHaveBeenCalledWith(
            '12345',
            expect.stringContaining('Already manually sent'),
            expect.any(Object)
        );
    });
});
