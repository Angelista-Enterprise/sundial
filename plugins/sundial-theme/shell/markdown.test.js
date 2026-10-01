// @vitest-environment jsdom
//
// The parser builds DOM nodes, so it is tested against a DOM. The alternative —
// asserting on a serialised string — would test a stringifier nobody runs.
//
// The safety tests are not decoration. This renders the least trusted text in
// the system: the model's answer, which may be repeating something a tool read
// off a web page or a file.
import { describe, expect, it } from 'vitest';
import { renderMarkdown, setCardLabel } from './markdown.js';

/** Render, and hand back a container to query. */
function md(text) {
  const root = document.createElement('div');
  root.append(renderMarkdown(text));
  return root;
}

const html = (text) => md(text).innerHTML;
const tags = (text) => [...md(text).children].map((node) => node.tagName.toLowerCase());

describe('safety', () => {
  it('never turns markup in the answer into markup on the page', () => {
    const root = md('Consider <script>alert(1)</script> and <img src=x onerror=alert(1)>.');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>alert(1)</script>');
  });

  it.each([['javascript:void'], ['data:text/html,x'], ['vbscript:x'], ['file:///etc/passwd']])(
    'renders a %s link as its own text rather than a working one',
    (href) => {
      const root = md(`[click me](${href})`);
      expect(root.querySelector('a')).toBeNull();
      expect(root.textContent).toBe('click me');
    },
  );

  // A URL with an unescaped `)` ends the link there — CommonMark does the same,
  // and the leftover renders as the text it is. Worth pinning because the
  // classic payload contains parens and it must still not become an anchor.
  it('still refuses a link whose scheme is unsafe and whose URL has parens', () => {
    const root = md('[click me](javascript:alert(1))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('click me)');
  });

  it('opens a safe link in a new tab, without handing it the opener', () => {
    const link = md('see [the ledger](/gnomon/ledger) and [docs](https://example.com)').querySelectorAll('a');
    expect([...link].map((a) => a.getAttribute('href'))).toEqual(['/gnomon/ledger', 'https://example.com']);
    expect(link[0].getAttribute('rel')).toBe('noreferrer noopener');
  });

  // A `board:` target is a place on this screen, so it is a button that asks
  // the board to move — never an anchor, and never dropped as an unsafe scheme.
  it('turns a board link into a button that asks for its card', () => {
    const seen = [];
    document.addEventListener('gnomon:card', (e) => seen.push(e.detail));
    const root = md('see [the goals card](board:inst:goals) and [the board](board:)');
    const buttons = root.querySelectorAll('button.board-link');
    expect(root.querySelector('a')).toBeNull();
    expect([...buttons].map((b) => b.textContent)).toEqual(['the goals card', 'the board']);
    for (const b of buttons) b.click();
    expect(seen).toEqual(['inst:goals', '']);
  });

  // A person card is `entity:<Name>`, and a name has a space in it. The board
  // matches the id's case itself, so the link passes it on as written.
  it('takes a board link whose card id has a space', () => {
    const seen = [];
    document.addEventListener('gnomon:card', (e) => seen.push(e.detail));
    const root = md('ask [Mira Bakker](board:entity:Mira Bakker) or [Mira](board:entity:mira bakker)');
    const buttons = root.querySelectorAll('button.board-link');
    expect(root.textContent).not.toContain('](board:');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Mira Bakker', 'Mira']);
    for (const b of buttons) b.click();
    expect(seen).toEqual(['entity:Mira Bakker', 'entity:mira bakker']);
  });

  // What the model actually writes when told to link a card: the brackets with
  // no target, or the id in backticks. Both name a card that can be opened, so
  // both are places — under the card's NAME, never its id — and a word that
  // names no card stays exactly what it was.
  it("makes a place of a card id the model named without a link, under the card's name", () => {
    setCardLabel((id) => ({ work: 'Work', 'inst:goals': 'Goals' })[id] ?? null);
    const root = md('**[inst:goals]** and the `work` card, not `translations.ts` or [a footnote]');
    expect([...root.querySelectorAll('button.board-link')].map((b) => b.textContent)).toEqual(['Goals', 'Work']);
    expect([...root.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['translations.ts']);
    expect(root.textContent).toContain('[a footnote]');
    setCardLabel(() => null);
  });
});

describe('inline', () => {
  it('renders bold, italic, strike and code', () => {
    expect(html('**b** *i* ~~s~~ `c`')).toBe('<p><strong>b</strong> <em>i</em> <del>s</del> <code>c</code></p>');
  });

  it('takes __ and _ as well', () => {
    expect(html('__b__ and _i_')).toBe('<p><strong>b</strong> and <em>i</em></p>');
  });

  it('leaves a code span literal — that is what backticks are for', () => {
    expect(html('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('nests inline inside emphasis', () => {
    expect(html('**bold with `code`**')).toBe('<p><strong>bold with <code>code</code></strong></p>');
  });

  it('resolves left to right, not in pattern order', () => {
    expect(html('`a` then **b**')).toBe('<p><code>a</code> then <strong>b</strong></p>');
  });

  // A snake_case identifier in prose is not italics, and a lone asterisk is not
  // an unterminated anything.
  it('leaves snake_case and a stray asterisk alone', () => {
    expect(html('call get_daily_context now')).toBe('<p>call get_daily_context now</p>');
    expect(html('2 * 3 = 6')).toBe('<p>2 * 3 = 6</p>');
  });

  it('draws a single newline inside a paragraph as a break', () => {
    expect(html('one\ntwo')).toBe('<p>one<br>two</p>');
  });
});

describe('blocks', () => {
  it('separates paragraphs on a blank line', () => {
    expect(tags('one\n\ntwo')).toEqual(['p', 'p']);
  });

  it('renders headings at their level', () => {
    expect(tags('# one\n\n### three')).toEqual(['h1', 'h3']);
  });

  it('renders a rule, and does not mistake a table separator for one', () => {
    expect(tags('---')).toEqual(['hr']);
    expect(tags('a\n\n***\n\nb')).toEqual(['p', 'hr', 'p']);
  });

  it('renders a blockquote, with its own blocks inside', () => {
    const root = md('> a quote\n> - and a bullet');
    expect(root.firstChild.tagName.toLowerCase()).toBe('blockquote');
    expect(root.querySelector('blockquote li')?.textContent).toBe('and a bullet');
  });

  it('renders fenced code literally, keeping the language', () => {
    const root = md('```bash\nls -la | grep "**"\n```');
    expect(root.querySelector('pre')?.getAttribute('data-lang')).toBe('bash');
    expect(root.querySelector('code')?.textContent).toBe('ls -la | grep "**"');
    expect(root.querySelector('strong')).toBeNull();
  });

  // The normal case mid-stream: the model is still typing the code block.
  it('renders an unclosed fence as the code it is becoming', () => {
    const root = md('here:\n```js\nconst a = 1');
    expect(root.querySelector('code')?.textContent).toBe('const a = 1');
  });
});

describe('lists', () => {
  it('renders bullets and numbers', () => {
    expect(tags('- a\n- b')).toEqual(['ul']);
    expect(tags('1. a\n2. b')).toEqual(['ol']);
    expect(md('- a\n- b').querySelectorAll('li')).toHaveLength(2);
  });

  it('nests by indent', () => {
    const root = md('- a\n  - b\n  - c\n- d');
    expect(root.querySelectorAll(':scope > ul > li')).toHaveLength(2);
    expect(root.querySelectorAll('li ul li')).toHaveLength(2);
  });

  it('keeps a one-line item tight — no paragraph inside the bullet', () => {
    expect(md('- just this').querySelector('li p')).toBeNull();
  });

  it('renders inline inside an item', () => {
    expect(md('- **a** and `b`').querySelector('li')?.innerHTML).toBe('<span><strong>a</strong> and <code>b</code></span>');
  });

  it('ends the list at the next paragraph', () => {
    expect(tags('- a\n\nafter')).toEqual(['ul', 'p']);
  });
});

describe('tables', () => {
  it('needs the header separator, so a line of pipes stays prose', () => {
    expect(tags('| this | is | prose |')).toEqual(['p']);
  });

  it('renders a table with its header and rows', () => {
    const root = md('| Day | Commits |\n| --- | ---: |\n| Mon | 4 |\n| Tue | 11 |');
    expect(root.querySelectorAll('th')).toHaveLength(2);
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('marks a right-aligned column numeric, which is where tabular figures belong', () => {
    const root = md('| Day | Commits |\n| --- | ---: |\n| Mon | 4 |');
    expect(root.querySelectorAll('th')[1].className).toBe('num');
    expect(root.querySelectorAll('td')[1].className).toBe('num');
    expect(root.querySelectorAll('td')[0].className).toBe('');
  });

  it('renders inline inside a cell', () => {
    expect(md('| a |\n| --- |\n| `x` |').querySelector('td code')?.textContent).toBe('x');
  });
});

describe('a real answer', () => {
  it('survives the shape a model actually writes', () => {
    const root = md(
      [
        '## Today',
        '',
        'You spent **2h 19m** on `puzzlebox-studio`, which is more than usual.',
        '',
        '| Project | Minutes |',
        '| --- | ---: |',
        '| puzzlebox-studio | 139 |',
        '',
        '- Two commits, both small',
        '  - one touched `vite.config.ts`',
        '- No meetings',
        '',
        '> The unattributed 53m is the part I could not explain.',
        '',
        '```bash',
        'git log --oneline -3',
        '```',
      ].join('\n'),
    );
    expect(tags(root.innerHTML) && [...root.children].map((n) => n.tagName.toLowerCase())).toEqual(['h2', 'p', 'div', 'ul', 'blockquote', 'pre']);
    expect(root.querySelector('strong')?.textContent).toBe('2h 19m');
    expect(root.querySelectorAll('li ul li')).toHaveLength(1);
  });

  it('is empty rather than a throw on nothing', () => {
    expect(md('').children).toHaveLength(0);
    expect(md(undefined).children).toHaveLength(0);
  });
});
