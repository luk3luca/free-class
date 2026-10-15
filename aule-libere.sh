#!/bin/bash
# free-class: free rooms per hour in the engineering buildings (UniBS UP Public data).
# Independent cross-check of the JS in app.js — both implementations must agree.
#
# Usage: bash aule-libere.sh [YYYY-MM-DD] [--classrooms-only]
#   --classrooms-only  only rooms usable for studying/lectures
#                      (Aula Lezioni / Aula Media / Aula Disegno), same as the site default
set -euo pipefail
cd "$(dirname "$0")"
DAY=""; SOLO=0
for a in "$@"; do
  case "$a" in
    --classrooms-only) SOLO=1 ;;
    *) DAY="$a" ;;
  esac
done
DAY="${DAY:-$(date +%Y-%m-%d)}"
NEXT=$(date -j -f "%Y-%m-%d" -v+1d "$DAY" "+%Y-%m-%d" 2>/dev/null || echo "$DAY")
# Europe/Rome offset for that day (CEST/CET), so the local day stays exact across the DST switch
OFF=$(TZ=Europe/Rome date -j -f "%Y-%m-%d %H:%M:%S" "$DAY 12:00:00" "+%z")
OFF="${OFF:0:3}:${OFF:3:2}"

API="https://unibs-public.prod.up.cineca.it/api"
EDIF="ING1:65d5a89e95ff13011395ec33 ING2:65d5a89e95ff13011395ec36 ING3:65d5a89e95ff13011395ec39 ING6:65d5a89e95ff13011395ec3c"
mkdir -p cache
for pair in $EDIF; do
  code=${pair%%:*}; id=${pair##*:}
  [ -f "cache/aule_$code.json" ] || curl -s "$API/Aule/getPerAutoCompletePublic?valore=&lookupFields=codice&lookupFields=descrizione&edificio=$id" -o "cache/aule_$code.json"
  curl -s "$API/Impegni/getImpegniPublic?edificio=$id&dataInizio=${DAY}T00:00:00%2B${OFF:1}&dataFine=${NEXT}T00:00:00%2B${OFF:1}&limit=1000" -o "cache/day_${DAY}_$code.json"
done

# room code -> room type, fetched once (the autocomplete endpoint does not expose tipoAula)
if [ ! -f cache/room_types.tsv ]; then
  for pair in $EDIF; do
    code=${pair%%:*}
    jq -r '.[]|.id' "cache/aule_$code.json" | while read -r rid; do
      curl -s "$API/Aule/getByIdPublic?id=$rid" | jq -r '[.codice, (.tipoAula.descrizione // "-")]|@tsv'
    done
  done | sort -u > cache/room_types.tsv
fi

jq -s -r '[.[] | select(type=="array") | .[] | [.codice, "x"]] | .[] | @tsv' cache/aule_ING*.json | sort -u > cache/_rooms.tsv
jq -s -r '[.[] | select(type=="array") | .[] | . as $i | $i.aule[] | [$i.dataInizio, $i.dataFine, .codice, $i.stato, ($i.evento.dettagliDidattici[0].nome // $i.evento.tipoAttivita.descrizione // $i.evento.tipoEvento.descrizione // "-")]] | .[] | @tsv' cache/day_${DAY}_ING*.json > cache/_bookings.tsv

awk -F'\t' -v solo="$SOLO" -v day="$DAY" -v off="$OFF" '
function tomin(iso,   h, m) { h=substr(iso,12,2)+substr(off,2,2); m=substr(iso,15,2); return h*60+m }
NR==FNR {
  if (solo==0) { room[$1]=1 }
  else if ($2=="Aula Lezioni" || $2=="Aula Media" || $2=="Aula Disegno") { room[$1]=1 }
  next
}
$4=="A" { cancelled++; next }                  # cancelled booking: the room stays free
{
  bstart[$3] = (($3 in bstart) ? bstart[$3] "," : "") tomin($1);
  bend[$3]   = (($3 in bend)   ? bend[$3]   "," : "") tomin($2);
  used[$3]=1;
}
END {
  printf "day %s | rooms considered: %d | with active bookings: %d | cancelled ignored: %d\n", day, length(room), length(used), cancelled;
  printf "%-13s %6s  %s\n", "SLOT", "FREE", "FREE ROOMS";
  for (h=8; h<20; h++) {
    s=h*60; e=s+60; n=0; list="";
    for (r in room) {
      b=0;
      if (r in bstart) {
        split(bstart[r], bs, ","); split(bend[r], be, ",");
        for (i in bs) if (bs[i] < e && be[i] > s) { b=1; break }
      }
      if (!b) { n++; list = list (list=="" ? "" : ", ") r }
    }
    printf "%02d:00-%02d:00 %6d  %s\n", h, h+1, n, list;
  }
}' cache/room_types.tsv cache/_bookings.tsv
