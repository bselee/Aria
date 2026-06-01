/**
 * @file    embedding.test.ts
 * @purpose Tests for the embedding generator and its local fallback.
 * @author  Will
 * @created 2026-06-01
 * @updated 2026-06-01
 * @deps    vitest, src/lib/intelligence/embedding
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embed, embedQuery, generateLocalFallbackEmbedding } from './embedding';

describe('Embedding module local fallback', () => {
    beforeEach(() => {
        vi.stubEnv('OPENAI_API_KEY', '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('should generate a 1024-dimensional vector using deterministic hashing', () => {
        const text = 'test document for hashing';
        const vector = generateLocalFallbackEmbedding(text);
        
        expect(vector).toBeInstanceOf(Array);
        expect(vector).toHaveLength(1024);
        
        // Assert that elements are numbers and it's not all zeros
        expect(vector[0]).toBeTypeOf('number');
        const sumOfSquares = vector.reduce((acc, val) => acc + val * val, 0);
        expect(sumOfSquares).toBeCloseTo(1.0, 5); // L2 normalized unit vector
    });

    it('should return identical vectors for identical inputs', () => {
        const text = 'identical input text';
        const vector1 = generateLocalFallbackEmbedding(text);
        const vector2 = generateLocalFallbackEmbedding(text);
        
        expect(vector1).toEqual(vector2);
    });

    it('should produce different vectors for different inputs', () => {
        const vectorA = generateLocalFallbackEmbedding('first unique document');
        const vectorB = generateLocalFallbackEmbedding('second unique document');
        
        expect(vectorA).not.toEqual(vectorB);
    });

    it('should fall back to local embedding if OPENAI_API_KEY is not set', async () => {
        const result = await embed('some user query text');
        expect(result).toHaveLength(1024);
        
        const sumOfSquares = result!.reduce((acc, val) => acc + val * val, 0);
        expect(sumOfSquares).toBeCloseTo(1.0, 5);
    });

    it('should generate a unit vector for empty strings without crashing', () => {
        const vector = generateLocalFallbackEmbedding('');
        expect(vector).toHaveLength(1024);
        expect(vector[0]).toBe(1.0);
        expect(vector.slice(1).every(v => v === 0)).toBe(true);
    });
});
