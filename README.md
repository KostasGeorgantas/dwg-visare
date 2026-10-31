# DWG-visare

En enkel Windows-app för att titta på AutoCAD-ritningar (.dwg): öppna, zooma, panorera och skriva ut.

## Installera

Ladda ner `DWG-visare-Setup-<version>.exe` från [Releases](https://github.com/KostasGeorgantas/dwg-visare/releases) och kör den. En äldre version ersätts automatiskt. Installationen kräver inga administratörsrättigheter och lägger appen i Start-menyn och på skrivbordet. .dwg-filer kopplas till appen, så du kan dubbelklicka på en ritning i Utforskaren.

Installationsfilen är inte kodsignerad. Windows SmartScreen kan därför visa "Windows skyddade datorn". Klicka på **Mer information** och sedan **Kör ändå**.

## Använda

| Gör så här | För att |
|---|---|
| **Öppna** / Ctrl+O / dra in filer | Öppna en eller flera ritningar, var och en i en egen flik |
| Klicka på en flik / Ctrl+Tab / Ctrl+PgDn och Ctrl+PgUp | Växla mellan ritningar |
| × på fliken / klick med mushjulet / Ctrl+W | Stäng en ritning |
| **Stödlinjer** / Ctrl+G | Visa eller dölj rutnät, axlar genom origo och hårkors |
| Mushjulet | Zooma kring markören |
| Dra med vänster eller mittenknappen | Panorera |
| Dubbelklicka med mushjulet / Ctrl+0 | Visa hela ritningen |
| Ctrl + / Ctrl − | Zooma in / ut |
| Piltangenterna | Panorera |
| **Linjetjocklek** / Ctrl+L | Visa eller dölj linjetjocklekar på skärmen |
| Ctrl+B | Byt mellan mörk och ljus bakgrund |
| **Skriv ut** / Ctrl+P | Skriv ut det som syns i fönstret, anpassat till papperet |

På skärmen visas ritningens färger. För utskriften väljer du **Färg** eller **Svartvit** uppe till höger. Med Svartvit blir alla linjer och texter svarta på papperet. Vit (AutoCAD-färg 7) blir alltid svart.

## Linjetyper och linjetjocklekar

- **Linjetyper** (streckade, streckprickade m.fl.) ritas med mönstret från ritningens linjetypstabell. Strecken skalas med objektets linjetypsskala och LTSCALE och följer zoomen, som i AutoCAD.
- **Linjetjocklekar** visas på skärmen när knappen Linjetjocklek är på. Linjer under 0,25 mm visas som 1 pixel. På utskriften blir tjockleken alltid den angivna i millimeter.
- ByLayer och ByBlock fungerar som i AutoCAD. Objekt på lager 0 inuti ett block får blockreferensens färg, linjetyp och linjetjocklek.

Varje flik minns sin egen zoom och position. Öppnar du en fil som redan är öppen visas den fliken i stället för en ny.

Stödlinjerna kommer aldrig med på utskriften. Rutnätet anpassar sig efter zoomen, och statusraden visar avståndet mellan linjerna i ritningens enheter. Var femte linje är kraftigare.

## Typsnitt

Varje textstil i ritningen pekar på ett typsnitt.

- **TrueType** (.ttf, .ttc, .otf): typsnittet läses från ritningens mapp eller från Windows typsnittsmappar och visas som i AutoCAD. Fler mappar, till exempel AutoCAD:s typsnittsmapp, kan anges i miljövariabeln `DWG_FONT_DIRS` (flera mappar separeras med `;`).
- **SHX** (AutoCAD:s egna typsnitt som txt, romans, simplex, isocp): kan inte visas exakt utan AutoCAD. De ersätts med [osifont](https://github.com/hikikomori82/osifont), ett tekniskt typsnitt enligt ISO 3098. Textens bredd kan därför skilja något mot AutoCAD.
- Saknas ett TrueType-typsnitt visas texten i Arial.

Statusraden visar hur många typsnitt ritningen använder och hur många som ersatts. Håll muspekaren över den för att se vilka.

Statusraden visar markörens koordinater i ritningens enheter, zoomnivån och filens DWG-format, t.ex. "DWG-format 2018 (AutoCAD 2018 och senare)". Formatet byts inte varje år, så det visar vilka AutoCAD-versioner som kan ha sparat filen. Äldre versioner än de som anges kan inte öppna filen utan att den först sparas ner.

## Skraffyr och fyllningar

- **Mönster** (t.ex. ANSI31, ANGLE, AR-CONC) ritas med linjerna från ritningen, klippta mot skraffyrens gräns. Öar blir hål.
- **Heltäckande fyllning** (SOLID) och **toningar** fyller ytan. Toningar visas som en linjär övergång mellan de två färgerna.
- **SOLID-objekt** (fyllda trianglar och fyrhörningar, t.ex. måttpilar) ritas fyllda.
- Mycket täta mönster över stora ytor (tusentals linjer) visas som en svag fyllning, så att appen inte blir seg.

Med svartvit utskrift blir fyllningar svarta, som med AutoCAD:s monochrome.ctb.

## Externa referenser (xref)

Xrefs läses in automatiskt och ritas på sin plats. Appen letar efter xref-filen så här:

1. Sökvägen som är sparad i ritningen, absolut eller relativ till ritningen.
2. Samma filnamn i ritningens mapp. Det gäller om projektet har flyttats eller kommer från någon annan dator.
3. Mappar i miljövariabeln `DWG_XREF_DIRS` (flera mappar separeras med `;`).

Lager, block och textstilar från xref-filen får prefixet `XREF|`, som i AutoCAD. Lager som är släckta eller frysta för xref:en i huvudritningen förblir dolda. Xrefs inuti xrefs läses i upp till tre nivåer. Klippta xrefs och block (XCLIP) visas bara innanför klippgränsen, och "Hela ritningen" räknar bara med den klippta delen.

Statusraden visar t.ex. "Xref 3". Om någon fil saknas står det i rött, t.ex. "1 av 3 xrefs saknas". Håll muspekaren över texten för att se vilka filer det gäller och var de hittades.

## Lager

Objekt på lager som är släckta eller frysta visas inte, precis som i AutoCAD. Färger följer AutoCAD: sann färg (RGB) på objekt och lager, färgindex 1–255, ByLayer och ByBlock. Färg 7 är vit på mörk bakgrund och svart på ljus.

## Begränsningar

- Bara modellrymden visas, inte layouter/pappersrymd.
- Blockattribut (t.ex. värdena i en ritningsstämpel) visas, utom de som är markerade som osynliga. Flerradiga attribut visas på en rad.
- Linjetyper med text eller symboler (t.ex. ---GAS---) visas bara som streck, utan texten.
- Vissa objekt ritas inte, t.ex. tabeller, inbäddade bilder, WIPEOUT, MLINE och multiledare. De hoppas över så att resten av ritningen visas.
- Toningar som är runda eller böjda (t.ex. SPHERICAL, CURVED) visas som linjära.
- Om ritningen har ett enstaka objekt långt bort från resten blir "Hela ritningen" väldigt utzoomad, precis som i AutoCAD.

## Bygga om

DWG-läsningen sköts av [libredwg-web](https://github.com/mlightcad/libredwg-web) (GPL-3.0). Biblioteket ligger i `src/vendor/` med några ändringar i SVG-konverteraren: objekt som inte går att rita hoppas över, enradig text ritas med rotation och justering, blockattribut ritas, blockets baspunkt och MINSERT-rader/kolumner används, spegelvända objekt (Z-axel nedåt) hamnar rätt, gamla polylinjer (POLYLINE) ritas, släckta och frysta lager döljs, färger (även RGB på lager) räknas som i AutoCAD, klippgränser (XCLIP) används, linjetyper och linjetjocklekar ritas (ltype_flags läses för ByLayer/ByBlock), skraffyr och SOLID ritas, block konverteras när de används (så att ordningen i filen inte spelar roll) och externa referenser känns igen. Själva inläsningen av xrefs sker i `src/app.js`. Ändringarna är märkta med `DWG-visare` i `src/vendor/dist/libredwg-web.js`.

```bash
npm install
```

```bash
npm start
```

```bash
npm run dist
```

`npm run dist` bygger Windows-installationen i `dist/`. På Linux eller macOS krävs Wine.

## Ny version

Skapa och pusha en versionstagg, så bygger GitHub Actions installationsfilen på Windows och publicerar den som en release:

```bash
git tag v1.9.0
```

```bash
git push origin v1.9.0
```

Versionen tas från taggen, så `package.json` behöver inte ändras. Det går också utan att pusha någon tagg: under fliken **Actions** väljer du **Release**, klickar på **Run workflow** och skriver versionen, t.ex. `v1.9.0`. Då skapas taggen och releasen från den gren du valt.
