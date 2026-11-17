# Material list link

The Materials dialog can send a schematic's material list to minemev:

```
https://www.minemev.com/material_list/new?code=<code>
```

`<code>` = base64url (no padding) of zlib-deflated UTF-8 JSON:

```jsonc
{
  "v": 1,                     // format version
  "mc": "1.21.1",             // items.json version the indexes refer to
  "n": "Iron Farm",           // schematic name (Metadata.Name, else file name, else "Untitled")
  "a": "Steve",               // author (Metadata.Author) — optional
  "f": "iron_farm.litematic", // file name — optional
  "s": [21, 30, 21],          // size in blocks [w, h, d] — optional
  "i": [[412, 1280], ...],    // [items.json "i" index, count]
  "x": [["decorated_pot", 3]] // items missing from items.json: [id without "minecraft:", count] — optional
}
```

Indexes in `i` refer to the shared `items.json` / atlas (`src/mcassets/` is a copy of
`https://www.minemev.com/mc/items.json`). Counts are items needed, not raw blocks
(double slabs = 2, doors/beds counted once, wall torches → torches, etc.; see
`blockToItems()` in `src/materials.js`).

## Decoding

Python:

```python
import base64, json, zlib

def decode_material_code(code: str) -> dict:
    raw = base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))
    return json.loads(zlib.decompress(raw))
```

JavaScript (browser, with pako): `decodeMaterialCode(code)` in `src/materials.js`.

Typical size: ~60 item types → ~630 character URL.
