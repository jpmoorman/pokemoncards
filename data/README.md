# Data

Files the app downloads once and keeps. Like `models/` and `vendor/`, a changed file gets a new
name, so the service worker can keep these for good.

## `details-<hash>.json`: card details

HP, stage, rarity, illustrator, regulation mark, attack and ability names, the start of the
trainer text and the printed versions of every English card, for the second ranking pass
(`js/rerank.js`, read by `js/details.js`). The name is a hash of the contents.

**Source.** The [TCGdex](https://tcgdex.dev) API (`api.tcgdex.net`), whose data is the
[TCGdex cards database](https://github.com/tcgdex/cards-database). Only public card data: nothing
from any photo.

**Licence.** The TCGdex cards database is licensed under the MIT License, Copyright (c) 2021
TCGdex: see `LICENSE` in this folder. This file is a cut-down copy of part of it (the fields
above, packed by `tools/build-details.mjs`). TCGdex notes that its database is not produced,
endorsed, supported or affiliated with Nintendo or The Pokémon Company; neither is this app.

**Refreshing it** (for new sets): see "The card details file" in the main `README.md`. In short,
run the private test-photo repo's **Snapshot card details** Action, then
`node tools/build-details.mjs ../pokemoncards-testphotos/catalog/details.json.gz`, which writes
the new file, deletes the old one and updates `js/assets.js`.
