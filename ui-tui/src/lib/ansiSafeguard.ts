/**
 * ANSI sequence safety utilities for preventing escape code leaks
 * during terminal rendering operations.
 */

/**
 * Ensures all ANSI sequences are properly terminated
 * This helps prevent escape code leaks during complex rendering operations
 */
export function ensureSafeAnsi(str: string): string {
  // List of ANSI sequence starters we need to ensure are terminated
  const sequences = [
    { start: '\x1b[7m', end: '\x1b[27m' }, // Invert
    { start: '\x1b[2m', end: '\x1b[22m' }, // Dim
    { start: '\x1b[1m', end: '\x1b[22m' }, // Bold
    { start: '\x1b[4m', end: '\x1b[24m' }, // Underline
    { start: '\x1b[5m', end: '\x1b[25m' }, // Blink
  ];

  // Check for any unterminated sequences and add their reset codes
  let result = str;
  
  for (const seq of sequences) {
    // Count occurrences of start and end sequences
    const startMatches = (result.match(new RegExp(seq.start.replace(/\[/g, '\\['), 'g')) || []).length;
    const endMatches = (result.match(new RegExp(seq.end.replace(/\[/g, '\\['), 'g')) || []).length;
    
    // If we have more starts than ends, add the missing end sequences
    if (startMatches > endMatches) {
      const missing = startMatches - endMatches;
      result += seq.end.repeat(missing);
    }
  }
  
  // Final safety - add a complete reset code at the end if there might be issues
  const hasAnyEscapeSequence = /\x1b\[/.test(result);
  if (hasAnyEscapeSequence) {
    result += '\x1b[0m';
  }
  
  return result;
}

/**
 * Reset all ANSI attributes to default
 */
export const RESET_ALL = '\x1b[0m';