function supportsPlaintextOnly() {
  const el = document.createElement('div');
  el.setAttribute('contenteditable', 'plaintext-only');
  document.body.appendChild(el);
  const isSupported = getComputedStyle(el).whiteSpace === 'pre-wrap';
  document.body.removeChild(el);

  return isSupported;
}

export function polyfillPlaintextOnly(input: HTMLDivElement) {
  if (supportsPlaintextOnly()) {
    // Browser is normal and doesn't take 9 years to implement a basic feature.
    return;
  }

  // Browser is firefox.
  input.setAttribute('contenteditable', 'true');

  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain');

    // remove all newlines
    const textWithoutNewlines = text?.replace(/\n/g, '');

    document.execCommand('insertText', false, textWithoutNewlines);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const blockedKeys = ['b', 'i', 'u'];

      if (blockedKeys.includes(e.key.toLowerCase())) {
        e.preventDefault();
      }
    }
  };

  input.addEventListener('paste', handlePaste);

  input.addEventListener('keydown', handleKeyDown);

  return () => {
    input.removeEventListener('paste', handlePaste);
    input.removeEventListener('keydown', handleKeyDown);
  };
}
