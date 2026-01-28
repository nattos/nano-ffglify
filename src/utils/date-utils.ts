
export class DateUtils {
  private static readonly MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  private static readonly DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /**
   * Converts a date-like value to a natural language string relative to a base date (default: now).
   * @param date Value to convert (Timestamp number, ISO string, or Date object)
   * @param baseDate The reference date (default: new Date())
   */
  static toNaturalDate(date: number | string | Date, baseDate: Date = new Date()): string {
    const d = new Date(date);
    if (isNaN(d.getTime())) return String(date); // Fallback for invalid dates

    const base = new Date(baseDate);
    // Reset time components for accurate day comparison
    const dZero = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const baseZero = new Date(base.getFullYear(), base.getMonth(), base.getDate());

    const diffTime = dZero.getTime() - baseZero.getTime();
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    if (diffDays === -1) return 'Yesterday';

    // Within last/next week (inclusive of 7 days)
    if (diffDays > -7 && diffDays < 0) {
      return `Last ${this.DAYS[d.getDay()]}`;
    }
    if (diffDays > 0 && diffDays < 7) {
      return `Next ${this.DAYS[d.getDay()]}`; // Or just the day name if preferred
    }

    // Otherwise standard format
    const yearDiff = d.getFullYear() - base.getFullYear();
    if (yearDiff === 0) {
      return `${this.MONTHS[d.getMonth()]} ${d.getDate()}`;
    }
    return `${this.MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /**
   * Recursively traverses an object and replaces timestamp-like fields with natural strings.
   * Target fields: 'created_at', 'updated_at', 'timestamp', 'start', 'end' (if they look like dates).
   */
  static transformStateNodes(obj: any, baseDate: Date = new Date()): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.transformStateNodes(item, baseDate));
    }

    const newObj: any = {};
    for (const key in obj) {
      const val = obj[key];
      // Check if key is a date-field candidate
      if (['created_at', 'updated_at', 'timestamp', 'start', 'end', 'fetched_at', 'expires_at'].includes(key)) {
        // Only convert if it looks like a valid date/timestamp
        // Filter out obviously non-date numbers (like small integers) if necessary,
        // but typically timestamps are large numbers > 1000000000 or ISO strings.
        if (typeof val === 'string' && !isNaN(Date.parse(val))) {
          newObj[key] = this.toNaturalDate(val, baseDate);
        } else if (typeof val === 'number' && val > 946684800000) { // > Year 2000 in ms
          newObj[key] = this.toNaturalDate(val, baseDate);
        } else {
          newObj[key] = this.transformStateNodes(val, baseDate);
        }
      } else {
        newObj[key] = this.transformStateNodes(val, baseDate);
      }
    }
    return newObj;
  }

  /**
   * Parses a natural language date string back to a timestamp number.
   * Supports: "Today", "Yesterday", "Tomorrow", "Next [Day]", "Last [Day]", "Month D, YYYY".
   */
  static parseNaturalDate(text: string, baseDate: Date = new Date()): number | null {
    if (!text) return null;
    const base = new Date(baseDate);
    const lower = text.toLowerCase().trim();

    if (lower === 'today') return base.getTime();

    if (lower === 'yesterday') {
      const d = new Date(base);
      d.setDate(d.getDate() - 1);
      return d.getTime();
    }

    if (lower === 'tomorrow') {
      const d = new Date(base);
      d.setDate(d.getDate() + 1);
      return d.getTime();
    }

    // "Next/Last [Day]"
    const dayMatch = lower.match(/^(next|last)\s+(\w+)$/);
    if (dayMatch) {
      const dir = dayMatch[1];
      const dayName = dayMatch[2];
      const targetDay = this.DAYS.findIndex(d => d.toLowerCase().startsWith(dayName)); // fuzzy match "mon" vs "monday" ? standard is full name

      if (targetDay === -1) return null;

      let currentDay = base.getDay();
      let diff = targetDay - currentDay;

      if (dir === 'next') {
        if (diff <= 0) diff += 7;
      } else { // last
        if (diff >= 0) diff -= 7;
      }

      const d = new Date(base);
      d.setDate(d.getDate() + diff);
      return d.getTime();
    }

    // Try standard date parsing
    const parsed = Date.parse(text);
    if (!isNaN(parsed)) return parsed;

    return null;
  }

  /**
   * Recursively traverses an object and converts natural date strings back to timestamp numbers.
   * Useful for cleaning up LLM tool arguments before validation/storage.
   */
  static restoreTimestamps(obj: any, baseDate: Date = new Date()): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.restoreTimestamps(item, baseDate));
    }

    const newObj: any = {};
    for (const key in obj) {
      const val = obj[key];
      // Keys that MUST be timestamps or dates
      if (['created_at', 'updated_at', 'timestamp', 'fetched_at', 'expires_at'].includes(key)) {
        if (typeof val === 'string') {
          const parsed = this.parseNaturalDate(val, baseDate);
          if (parsed !== null) newObj[key] = parsed; // Convert to number
          else newObj[key] = val;
        } else {
          newObj[key] = this.restoreTimestamps(val, baseDate);
        }
      } else if (['start', 'end'].includes(key)) {
        if (typeof val === 'string') {
          const parsed = this.parseNaturalDate(val, baseDate);
          if (parsed !== null) newObj[key] = new Date(parsed).toISOString(); // Convert to ISO String
          else newObj[key] = val;
        } else {
          newObj[key] = this.restoreTimestamps(val, baseDate);
        }
      } else {
        newObj[key] = this.restoreTimestamps(val, baseDate);
      }
    }
    return newObj;
  }
}
