
import { describe, it, expect } from 'vitest';
import { DateUtils } from '../src/utils/date-utils';

describe('DateUtils', () => {
  const BASE_DATE = new Date('2026-01-24T12:00:00Z'); // Saturday

  describe('toNaturalDate', () => {
    it('handles Today', () => {
      expect(DateUtils.toNaturalDate(new Date('2026-01-24T09:00:00Z'), BASE_DATE)).toBe('Today');
    });

    it('handles Yesterday', () => {
      const yesterday = new Date(BASE_DATE);
      yesterday.setDate(yesterday.getDate() - 1);
      expect(DateUtils.toNaturalDate(yesterday, BASE_DATE)).toBe('Yesterday');
    });

    it('handles Tomorrow', () => {
      const tomorrow = new Date(BASE_DATE);
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(DateUtils.toNaturalDate(tomorrow, BASE_DATE)).toBe('Tomorrow');
    });

    it('handles Last Week (within 7 days)', () => {
      const lastWed = new Date(BASE_DATE);
      lastWed.setDate(lastWed.getDate() - 3); // Sat -> Wed
      expect(DateUtils.toNaturalDate(lastWed, BASE_DATE)).toBe('Last Wednesday');
    });

    it('handles Next Week (within 7 days)', () => {
      const nextMon = new Date(BASE_DATE);
      nextMon.setDate(nextMon.getDate() + 2); // Sat -> Mon
      expect(DateUtils.toNaturalDate(nextMon, BASE_DATE)).toBe('Next Monday');
    });

    it('handles same year dates', () => {
      const d = new Date(2026, 0, 1);
      expect(DateUtils.toNaturalDate(d, BASE_DATE)).toBe('Jan 1');
    });

    it('handles different year dates', () => {
      const d = new Date(2025, 11, 31);
      expect(DateUtils.toNaturalDate(d, BASE_DATE)).toBe('Dec 31, 2025');
    });

    it('handles timestamps', () => {
      const d = new Date(BASE_DATE);
      d.setHours(10);
      expect(DateUtils.toNaturalDate(d.getTime(), BASE_DATE)).toBe('Today');
    });
  });

  describe('transformStateNodes', () => {
    it('replaces date fields in object', () => {
      const obj = {
        id: '1',
        created_at: new Date(BASE_DATE).getTime(),
        updated_at: new Date(BASE_DATE.getTime() - 86400000).toISOString(),
        other: 'value'
      };
      const transformed = DateUtils.transformStateNodes(obj, BASE_DATE);
      expect(transformed.created_at).toBe('Today');
      expect(typeof transformed.updated_at).toBe('string');
      expect(transformed.other).toBe('value');
    });

    it('recursively transforms arrays and nested objects', () => {
      const list = [
        { id: '1', start: '2026-01-25' },
        { id: '2', nested: { ends: '2025-12-31', timestamp: 1700000000000 } }
      ];

      const transformed = DateUtils.transformStateNodes(list, BASE_DATE);

      expect(transformed[0].start).toMatch(/Tomorrow|Next Sunday/);
      expect(transformed[1].nested.ends).toBe('2025-12-31');

      // Timestamp check
      expect(transformed[1].nested.timestamp).not.toBe(1700000000000);
      expect(typeof transformed[1].nested.timestamp).toBe('string');
    });
  });

  describe('parseNaturalDate', () => {
    it('parses "Today"', () => {
      const result = DateUtils.parseNaturalDate('Today', BASE_DATE);
      expect(result).toBe(BASE_DATE.getTime());
    });

    it('parses "Yesterday"', () => {
      const result = DateUtils.parseNaturalDate('Yesterday', BASE_DATE);
      const yesterday = new Date(BASE_DATE); yesterday.setDate(yesterday.getDate() - 1);
      expect(result).toBe(yesterday.getTime());
    });

    it('parses "Next Monday"', () => {
      // Sat Jan 24 -> Next Mon Jan 26
      const result = DateUtils.parseNaturalDate('Next Monday', BASE_DATE);
      const mon = new Date('2026-01-26T12:00:00Z');
      expect(result).toBe(mon.getTime());
    });

    it('parses "Last Wednesday"', () => {
      // Sat Jan 24 -> Last Wed Jan 21
      const result = DateUtils.parseNaturalDate('Last Wednesday', BASE_DATE);
      const wed = new Date('2026-01-21T12:00:00Z');
      expect(result).toBe(wed.getTime());
    });

    it('parses ISO string fallback', () => {
      expect(DateUtils.parseNaturalDate('2026-01-01', BASE_DATE)).not.toBeNull();
    });
  });

  describe('restoreTimestamps', () => {
    it('converts natural dates back to numbers', () => {
      const input = {
        created_at: 'Today',
        updated_at: '2026-01-01T00:00:00Z', // ISO string should parse via Date.parse
        other: 'value'
      };

      const restored = DateUtils.restoreTimestamps(input, BASE_DATE);
      expect(restored.created_at).toBe(BASE_DATE.getTime());
      expect(typeof restored.updated_at).toBe('number');
      expect(restored.other).toBe('value');
    });

    it('handles nested objects', () => {
      const input = {
        list: [{ start: 'Next Monday' }]
      };
      const restored = DateUtils.restoreTimestamps(input, BASE_DATE);
      // Next Monday from Jan 24 is Jan 26
      const mon = new Date('2026-01-26T12:00:00Z');
      expect(new Date(restored.list[0].start).getTime()).toBe(mon.getTime());
    });
  });
});
