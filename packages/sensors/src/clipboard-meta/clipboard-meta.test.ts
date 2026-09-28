import { describe, it, expect } from 'vitest';
import { classifyClipboardContent } from './clipboard-meta-capture.js';

describe('classifyClipboardContent', () => {
  it('classifies a bare URL', () => {
    expect(classifyClipboardContent('https://example.com/path')).toBe('url');
  });

  it('classifies an absolute or home-relative path as a file', () => {
    expect(classifyClipboardContent('/Users/x/Projects/gnomon/README.md')).toBe('file');
    expect(classifyClipboardContent('~/Projects/gnomon/README.md')).toBe('file');
  });

  it('classifies something with multiple code signals as code', () => {
    expect(classifyClipboardContent('function foo() {\n  return 1;\n}')).toBe('code');
  });

  it('classifies plain prose as text', () => {
    expect(classifyClipboardContent('just a regular sentence about lunch plans')).toBe('text');
  });

  it('classifies empty/whitespace-only content as unknown', () => {
    expect(classifyClipboardContent('   ')).toBe('unknown');
  });
});
