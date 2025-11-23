# ARXML Tree Viewer
Visualize and navigate AUTOSAR ARXML files directly inside VS Code. The extension parses the document into a tree, keeps bookmarks that survive reloads, and lets you jump between references without losing your spot.

## Installation
1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/).
2. Open any `.arxml` file. The **ARXML Tree View** appears in the Activity Bar the first time the language is detected.
3. Run `npm install` and `npm run esbuild` inside the repository if you are developing the extension locally.

## Features
- **Tree View:** Streams the ARXML file with a SAX parser so nested components show up regardless of formatting. Selecting a node reveals the exact range in the editor.
- **Cross-File Hover Navigation:** Hovering over any `*REF DEST="..."` element shows a clickable link that jumps to the matching ARPATH, even if it's in a different open ARXML file. The hover tooltip displays the target filename for cross-file references.
- **Persistent Bookmarks:** Add bookmarks from the tree view context menu. Entries are stored per-workspace so they survive editor reloads.
- **Focus Sync:** Clicking in the editor highlights and focuses the closest node in the tree, keeping both views aligned.

![Demo](https://github.com/robinbreast/vscode-arxml-tree/blob/main/resources/images/arxml-tree-demo.gif?raw=true)

## Usage
### Tree View
Use the **ARTree: Refresh** command or the refresh button in the tree view title to rebuild the tree. Double-clicking a node reveals it in the editor, and the `Focus node` command keeps the tree selection in sync with your caret.

### Bookmarks
Right-click any tree node and choose **ARTree: Add bookmark**. The bookmark appears in the **Bookmarks** tree. Use the context menu (or the command palette) to remove entries. Selecting a bookmark reveals it in the editor and tree.

### Hover Links & Go-To
Move the cursor over a `REF DEST="..."` element to get a trusted link. The extension searches across **all open ARXML files** to find the target. If found in a different file, the hover shows a 📄 icon with the filename. Clicking the link executes **ARTree: Goto node**, which resolves the ARPATH and reveals it in the correct file, even opening the file if needed.

## Commands
- `ARTree: Refresh` — rebuild the tree for the active ARXML file.
- `ARTree: Reveal in file` — jump to the range represented by the selected node.
- `ARTree: Focus node` — focus the node in the tree without changing selection.
- `ARTree: Add bookmark` — store the node in the persistent bookmark list.
- `ARTree: Remove bookmark` — delete the selected bookmark.
- `ARTree: Goto node` — used by hover links to resolve ARPATH references.

## Limitations & Tips
- **Cross-File Navigation:** The extension can only navigate to references in currently **open** ARXML files. If a reference shows "Not found in open files", open the target ARXML file containing that definition.
- **ECUC Definitions:** Some AUTOSAR ECUC module definitions (like `/MICROSAR/Rte/...`) may be in separate definition files. Open these files for full navigation support.
- Parsing requires valid XML. If the document contains syntax errors the extension reports them in VS Code's notification area.
- Bookmark ranges are not updated automatically if you edit above the saved lines. Use the ARPATH link inside the bookmark tooltip to re-sync when needed.
- Large ARXML files are parsed incrementally, but frequent edits can still be expensive. Edits are debounced to avoid rebuilding the tree on every keystroke.

## Contributing & Testing
The repository includes unit tests for the parser and bookmark manager. Run `npm test` to execute them. Contributions are welcome—please document new commands or settings in this README and update the changelog below.
