# Change Log

## [0.1.5]
- **Cross-File Navigation:** Hover navigation now works across multiple open ARXML files. The extension indexes all open files and shows the target filename when hovering over cross-file references.
- **Text Search Fallback:** Added fallback text search for ECUC definitions and elements not parsed as SHORT-NAME nodes.
- **Bug Fix:** Fixed critical bug where switching away from ARXML files would clear the parsed documents cache, breaking cross-file navigation.
- **Improved Search:** Enhanced text search with multiple pattern matching for better reference resolution.
- **Security:** Updated js-yaml dependency to 4.1.1 to address CVE-2025-64718 vulnerability.

## [0.1.4]
- Rebuilt the ARXML tree builder using a streaming SAX parser for reliable navigation.
- Added persistent bookmarks with remove command and VS Code context menu support.
- Improved hover detection for `REF DEST` links and introduced parser/ bookmark unit tests.
## [0.1.3]
- Security update
## [0.1.2]
- Apply xml syntax highlighting
## [0.1.1]
- Improve performance with big size arxml file
- Fix hover link issue
- Reveal node in tree when mouse click on editor
## [0.1.0]
- Initial release
