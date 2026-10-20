import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jumpToField } from './composer-jump';

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('jumpToField', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('returns false when no element has the id', () => {
    expect(jumpToField('missing')).toBe(false);
  });

  it('scrolls the target into the centre of the viewport', () => {
    mount('<input id="a" />');
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    expect(jumpToField('a')).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('flashes the [data-flash] ancestor', () => {
    mount('<div data-flash id="box"><input id="a" /></div>');
    jumpToField('a');
    expect(document.getElementById('box')).toHaveClass('animate-field-flash');
  });

  it('restarts the flash when the ancestor already carries it', () => {
    mount('<div data-flash id="box" class="animate-field-flash"><input id="a" /></div>');
    const box = document.getElementById('box');
    const remove = vi.spyOn(box?.classList ?? document.body.classList, 'remove');
    jumpToField('a');
    expect(remove).toHaveBeenCalledWith('animate-field-flash');
    expect(box).toHaveClass('animate-field-flash');
  });

  it('clears the flash class once the flash window has elapsed', () => {
    mount('<div data-flash id="box"><input id="a" /></div>');
    jumpToField('a');
    vi.advanceTimersByTime(1399);
    expect(document.getElementById('box')).toHaveClass('animate-field-flash');
    vi.advanceTimersByTime(1);
    expect(document.getElementById('box')).not.toHaveClass('animate-field-flash');
  });

  it('does not let an earlier jump clear a restarted flash', () => {
    mount('<div data-flash id="box"><input id="a" /></div>');
    jumpToField('a');
    vi.advanceTimersByTime(1000);
    jumpToField('a');
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('box')).toHaveClass('animate-field-flash');
    vi.advanceTimersByTime(400);
    expect(document.getElementById('box')).not.toHaveClass('animate-field-flash');
  });

  it('focuses a target that has no flash ancestor without flashing', () => {
    mount('<button id="add">Add milestone</button>');
    jumpToField('add');
    vi.advanceTimersByTime(400);
    expect(document.getElementById('add')).toHaveFocus();
    expect(document.querySelector('.animate-field-flash')).toBeNull();
  });

  it('waits for the smooth scroll before focusing', () => {
    mount('<input id="a" />');
    jumpToField('a');
    expect(document.getElementById('a')).not.toHaveFocus();
    vi.advanceTimersByTime(380);
    expect(document.getElementById('a')).toHaveFocus();
  });

  it('focuses the first focusable descendant of a wrapper', () => {
    mount(
      '<div id="wrap" data-flash tabindex="-1"><div id="editor" contenteditable="true" tabindex="0"></div></div>'
    );
    jumpToField('wrap');
    vi.advanceTimersByTime(400);
    expect(document.getElementById('editor')).toHaveFocus();
  });

  it('focuses the wrapper itself when it contains nothing focusable', () => {
    mount('<div id="wrap" data-flash tabindex="-1"></div>');
    jumpToField('wrap');
    vi.advanceTimersByTime(400);
    expect(document.getElementById('wrap')).toHaveFocus();
  });

  it('scrolls instantly and focuses at once under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true } as unknown as MediaQueryList)
    );
    mount('<input id="a" />');
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    jumpToField('a');
    expect(scroll).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    vi.advanceTimersByTime(0);
    expect(document.getElementById('a')).toHaveFocus();
    vi.unstubAllGlobals();
  });
});
