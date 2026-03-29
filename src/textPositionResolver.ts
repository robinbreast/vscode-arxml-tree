import * as vscode from 'vscode';

export function createTextPositionResolver(text: string): (offset: number) => vscode.Position {
  let cursorOffset = 0;
  let cursorLine = 0;
  let cursorCharacter = 0;

  return (offset: number) => {
    const clamped = Math.max(0, Math.min(text.length, offset));

    if (clamped < cursorOffset) {
      cursorOffset = 0;
      cursorLine = 0;
      cursorCharacter = 0;
    }

    while (cursorOffset < clamped) {
      if (text[cursorOffset] === '\n') {
        cursorLine++;
        cursorCharacter = 0;
      } else {
        cursorCharacter++;
      }
      cursorOffset++;
    }

    return new vscode.Position(cursorLine, cursorCharacter);
  };
}
