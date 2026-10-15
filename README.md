# free-class — free classrooms at UniBS Engineering (ING1 · ING2 · ING3 · ING6)

A single static page that answers one question: **which classrooms are free right now, and for how long?**
It reads the public booking data of the University of Brescia UP portal
(`https://unibs-public.prod.up.cineca.it`) directly from the browser and shows *only the free rooms*,
with the time range during which each one is free.

No build step, no server, no dependencies, no login. Open `index.html`.

## Usage

```
open index.html          # macOS: double-click works too
```

- **Giorno** (default): one row per free classroom, green blocks = free intervals inside the selected
  hours (default 08:00–20:00). Rooms with no free slot in that window are not shown.
- **Adesso** panel (only when the selected day is today): free rooms right now, sorted by how long
  they stay free.
- **Settimana**: rooms × Mon–Fri, each cell lists the free intervals; click a cell to open that day.
- Filters: buildings (ING1/ING2/ING3/ING6), room type (Aule on, Laboratori/Sale off), minimum seats, text filter.

Data refreshes every 5 minutes while the page is open on today; the `↻` button forces a reload.

## Data source

Public REST API of the Cineca "UP" platform, no authentication:

| Purpose | Endpoint |
|---|---|
| Bookings | `/api/Impegni/getImpegniPublic?edificio=<id>&dataInizio=<iso>&dataFine=<iso>&limit=2000` |
| Room list | `/api/Aule/getPerAutoCompletePublic?lookupFields=codice&lookupFields=descrizione&edificio=<id>` |
| Room detail | `/api/Aule/getByIdPublic?id=<id>` |

Rules applied when turning bookings into availability (each one was verified against the portal):

- **`limit` is mandatory.** The portal's default is 150 items and it truncates silently; a single
  building-week already has ~250 bookings.
- **`stato: "A"` = cancelled** → the room is treated as free (a cancelled lesson releases the room).
- **Times are UTC**, converted to Europe/Rome here; the DST offset is computed per date, never hard-coded.
- **One booking can hold several rooms** → split into one entry per room.
- Bookings without a room, and the fake `ON LINE` room, are dropped.
- Rooms with `capienzaEffettiva = 0` (e.g. the machine shop in ING3) are hidden: they are not seats.
- Timetables are published **in batches**; a room that looks free far in the future may be booked later.
  The footer states this, and a banner appears when a day has no bookings at all.

## Files

| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the site (plain HTML/CSS/JS, no framework) |
| `rooms.js` | room inventory for ING1, ING2, ING3, ING6 (`window.ROOMS`), generated from the API |
| `aule-libere.sh` | independent shell/jq prototype that computes the same thing — used to cross-check the JS |
| `NOTES-esplorazione.md` | exploration notes: portal limitations, API quirks, room inventory, design rationale (Italian) |
| `_dati-esplorazione/` | raw snapshots: room inventory JSONL, room types, sample free-room output |

## Refreshing the room inventory

`rooms.js` changes only when the university adds/renames rooms. Regenerate it by fetching the room list
and each room's detail per building (see `aule-libere.sh` for the request shape), or re-run the
prototype script and rebuild `rooms.js` from its output.
