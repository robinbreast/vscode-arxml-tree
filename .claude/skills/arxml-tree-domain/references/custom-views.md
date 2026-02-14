# Custom Views Configuration

Custom views are stored in a JSON file and applied per ARXML document. The main Tree view shows all parsed files, with each file using its own selected view (or default).

## File location

The file location depends on `arxmlTree.customViewStorageScope`:

- `workspace` (default): [`.vscode/arxmlTree.customViews.json`](../../../../.vscode/arxmlTree.customViews.json)
- global: <extension global storage>/customViews.json (extension-managed path)

Use **ARTree: Edit custom views file** to open the correct file.

Changes take effect when the file is saved.

## JSON schema

The file contains an array of custom view objects:

```json
[
  {
    "id": "my-view-id",
    "name": "My View",
    "description": "Optional description",
    "filters": {
      "arpathPrefix": "/AUTOSAR",
      "elementTags": ["ECUDOC", "ATTRCAT"],
      "textContains": "Diag",
      "uuidFilter": "present"
    },
    "nameTags": ["SHORT-NAME", "NAME"],
    "nameTextTags": ["TUV"],
    "parseMode": "lenient",
    "sort": "name"
  }
]
```

## Field reference

Required:
- `id`: Unique string identifier.
- `name`: Display name for the view.
- `filters`: Filter object (can be empty).

Optional:
- `description`: Short description shown in the Custom Views list.
- `filters.arpathPrefix`: Keep nodes whose ARPATH starts with this prefix.
- `filters.elementTags`: Keep nodes whose element tag is in the list.
- `filters.textContains`: Keep nodes whose name contains this text (case-insensitive).
- `filters.uuidFilter`: `present` or `missing` to filter by UUID.
- `nameTags`: Tags that should provide a name. Default: `["SHORT-NAME"]`.
- `nameTextTags`: Tags that provide text for name tags when they appear as children (default: empty).
- `parseMode`: `strict` (default) or `lenient`.
  - `strict`: fail on malformed XML structures for stricter parsing.
  - `lenient`: continue parsing with best-effort recovery for imperfect inputs.
- `sort`: `name` or `arpath`.

## Examples

Default ARXML view (SHORT-NAME only):

```json
{
  "id": "arxml-default",
  "name": "ARXML: Default",
  "filters": {},
  "parseMode": "strict"
}
```

CDD view (Complex Device Description):

```json
{
  "id": "cdd",
  "name": "CDD: Complex Device Description",
  "description": "Complex Device Description definitions",
  "filters": {
    "elementTags": ["ECUDOC", "ATTRCAT", "STRDEF", "ENUMDEF", "UNSDEF", "CSTRDEF", "DIAGCLASSATTS", "DIAGINSTATTS", "ECUATTS"]
  },
  "nameTags": ["SHORT-NAME", "NAME"],
  "nameTextTags": ["TUV"],
  "parseMode": "lenient",
  "sort": "name"
}
```
