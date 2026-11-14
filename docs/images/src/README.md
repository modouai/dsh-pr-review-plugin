# README screenshots

`mock.html` renders the four images in `docs/images/`. It is a static mock with a fictional repository (`acme/portal`, PR #128); it contains no product data and does not load `client.js`. The `view` and `lang` query parameters select the state:

| URL | File |
|---|---|
| `?view=overview&lang=zh` | `docs/images/panel-overview.zh.png` |
| `?view=diff&lang=zh` | `docs/images/panel-diff.zh.png` |
| `?view=overview&lang=en` | `docs/images/panel-overview.en.png` |
| `?view=diff&lang=en` | `docs/images/panel-diff.en.png` |

Regenerate from this directory:

```sh
python3 -m http.server 8765
```

Open `http://127.0.0.1:8765/mock.html?view=overview&lang=zh` and capture a 1800×1000 viewport. Repeat for the other three URLs.

The mock follows the panel's real layout, labels, and state. Update it by hand when the panel UI changes.
