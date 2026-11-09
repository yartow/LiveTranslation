---
title: "CTT.AY — Handleiding"
subtitle: "Live preken vertalen, stap voor stap"
lang: nl
---

# Wat is CTT.AY?

CTT.AY (*Contextual Transcriptions & Translations*, uitgesproken als *"stay"*) luistert mee
met een preek, schrijft op wat er gezegd wordt en vertaalt het meteen naar het Engels.

Op het scherm zie je twee kolommen naast elkaar: links de Nederlandse tekst, rechts de
Engelse vertaling. Beide kolommen kun je tijdens de preek verbeteren. Wie geen Nederlands
spreekt, kan de Engelse tekst live volgen op de eigen telefoon, zonder een app te installeren.

De app draait op je eigen computer. Je opent hem in de webbrowser, maar hij staat niet op
internet: alleen apparaten op hetzelfde wifi-netwerk kunnen meelezen.

Deze handleiding is bedoeld voor wie de app voor het eerst installeert en gebruikt. Je hoeft
niet te kunnen programmeren. Je typt wel een paar keer een opdracht in een zwart venster, de
*terminal*. Elke opdracht staat hieronder letterlijk uitgeschreven: je kunt hem kopiëren en
plakken.

# Wat heb je nodig?

## Welke computer?

De huidige versie is **gemaakt voor een Mac met een Apple-chip** (M1, M2, M3, M4 of nieuwer).
Op zo'n Mac kan de spraakherkenning helemaal op de computer zelf draaien: gratis, zonder
internet voor dat deel, en zonder dat het geluid de computer verlaat.

Heb je **geen Mac met Apple-chip** (een Windows-pc, of een oudere Mac met een Intel-processor)?
Dan kun je de app ook gebruiken, maar dan gebeurt de spraakherkenning online, via OpenAI.
Daarvoor heb je een **OpenAI API-sleutel** nodig (zie hieronder).

| Computer | Spraakherkenning | Vertaling | Nodig |
|-------------|---------------------|-------------------|---------------------|
| Mac met Apple-chip | Op de Mac zelf (gratis) of via OpenAI | OpenAI, Anthropic (Claude) of lokaal | Node.js, Python; een API-sleutel voor de vertaling |
| Mac met Intel-processor | Via OpenAI | OpenAI of Anthropic (Claude) | Node.js; OpenAI-sleutel |
| Windows-pc | Via OpenAI | OpenAI of Anthropic (Claude) | Node.js; OpenAI-sleutel |

Weet je niet welke Mac je hebt? Klik linksboven op het Apple-logo en kies **Over deze Mac**.
Staat er bij *Chip* "Apple M1" (of M2, M3, ...), dan heb je een Apple-chip. Staat er
*Processor* met "Intel", dan niet.

> **Let op:** een Anthropic-sleutel (voor Claude) alleen is niet genoeg. Claude vertaalt, maar
> kan geen spraak herkennen. Zonder Mac met Apple-chip heb je dus altijd een OpenAI-sleutel
> nodig. Een Anthropic-sleutel is een optionele extra voor de vertaling.

## De rest

- **Google Chrome** (of Microsoft Edge). Andere browsers werken minder goed.
- **Een microfoon.** De ingebouwde microfoon werkt, maar een losse microfoon of een
  aansluiting op de geluidsinstallatie van de kerk geeft veel betere tekst.
- **Internet**, voor de vertaling en (zonder Apple-chip) voor de spraakherkenning.
- **Een API-sleutel** van OpenAI en/of Anthropic. Een API-sleutel is een soort wachtwoord
  waarmee de app namens jou de diensten van OpenAI of Anthropic gebruikt. Je betaalt per
  gebruik.
- **Ongeveer een half uur** voor de eerste installatie.

## Een API-sleutel aanmaken

**OpenAI** (spraakherkenning en vertaling):

1. Ga naar <https://platform.openai.com> en maak een account aan.
2. Voeg onder *Billing* een betaalmethode en wat tegoed toe (bijvoorbeeld 10 dollar).
3. Ga naar *API keys* en klik op **Create new secret key**.
4. Kopieer de sleutel (hij begint met `sk-`) en bewaar hem op een veilige plek. Je ziet hem
   maar één keer.

**Anthropic** (optioneel, vertaling met Claude):

1. Ga naar <https://console.anthropic.com> en maak een account aan.
2. Voeg onder *Billing* tegoed toe.
3. Maak onder *API Keys* een sleutel aan (hij begint met `sk-ant-`) en bewaar hem.

**Wat kost het?** De spraakherkenning van OpenAI kost ongeveer 0,6 dollarcent per minuut,
dus zo'n 35 dollarcent per uur. De vertaling kost per uur meestal nog enkele dollarcenten
daarbovenop. Reken voor een dienst van een uur op minder dan een dollar.

Geef een API-sleutel nooit aan anderen: wie hem heeft, kan op jouw kosten de dienst gebruiken.

# Installatie (eenmalig)

Deze stappen doe je één keer per computer.

## Stap 1: Node.js installeren

Node.js is het programma waarop de app draait.

1. Ga naar <https://nodejs.org>.
2. Download de versie met **LTS** erbij (de aanbevolen versie).
3. Open het gedownloade bestand en volg de installatie. Je kunt overal de standaardkeuze laten
   staan.

## Stap 2: De app downloaden

1. Ga naar <https://github.com/yartow/LiveTranslation>.
2. Klik op de groene knop **Code** en daarna op **Download ZIP**.
3. Pak het ZIP-bestand uit (dubbelklik op de Mac; op Windows: rechtsklik en
   **Alles uitpakken**).
4. Verplaats de uitgepakte map (`LiveTranslation-main`) naar je map **Documenten**.

## Stap 3: Een terminal openen in de map van de app

De terminal is een venster waarin je opdrachten typt. Hij moet "in" de map van de app staan.

**Op de Mac:**

1. Open **Terminal** (zoek met Cmd+spatie op "Terminal").
2. Typ `cd` gevolgd door een spatie. Druk nog niet op Return.
3. Sleep de map `LiveTranslation-main` vanuit de Finder in het terminalvenster. Het pad
   verschijnt achter `cd`.
4. Druk op Return.

**Op Windows:**

1. Open de map `LiveTranslation-main` in de Verkenner.
2. Klik in de adresbalk bovenin (waar het pad staat), typ `cmd` en druk op Enter.
3. Er opent een zwart venster dat al in de juiste map staat.

## Stap 4: De onderdelen van de app installeren

Typ in de terminal:

```
npm install
```

en druk op Return/Enter. Dit duurt een paar minuten. Er verschijnt veel tekst; meldingen
met *warn* of *vulnerabilities* kun je negeren.

Zegt de terminal *"npm: command not found"* of *"npm wordt niet herkend"*? Sluit dan het
terminalvenster, open het opnieuw (stap 3) en probeer het nog eens. Helpt dat niet, dan is
stap 1 niet gelukt.

## Stap 5: Je API-sleutels invullen

De app leest je sleutels uit een bestand met de naam `.env` in de map van de app.

**Op de Mac**, typ in de terminal:

```
cp .env.example .env
open -e .env
```

**Op Windows**, typ in de terminal:

```
copy .env.example .env
notepad .env
```

Er opent een tekstbestand. Zoek deze regels en zet je eigen sleutel achter het `=`-teken,
zonder spaties en zonder aanhalingstekens:

```
OPENAI_API_KEY=sk-jouw-eigen-sleutel
ANTHROPIC_API_KEY=sk-ant-jouw-eigen-sleutel
```

Heb je geen Anthropic-sleutel? Maak die regel dan leeg: `ANTHROPIC_API_KEY=`. Laat de rest
van het bestand zoals het is. Sla op en sluit het bestand.

## Stap 6 (alleen Mac met Apple-chip): spraakherkenning op de Mac zelf

Deze stap is optioneel. Sla hem over als je OpenAI voor de spraakherkenning gebruikt.

Voor spraakherkenning op de Mac zelf heb je Python nodig, met daarin het onderdeel
`mlx-whisper`. Typ in de terminal, regel voor regel:

```
python3 -m venv ~/ctt-python
~/ctt-python/bin/pip install mlx-whisper
echo ~/ctt-python/bin/python3
```

- Vraagt de Mac na de eerste regel om **ontwikkelaarstools** te installeren? Klik op
  *Installeer*, wacht tot het klaar is en typ de regels opnieuw.
- De laatste regel toont een pad, bijvoorbeeld `/Users/jan/ctt-python/bin/python3`.
  Kopieer dat.

Open het `.env`-bestand opnieuw (`open -e .env`), zoek de regel `MLX_PYTHON=` en plak het pad
erachter:

```
MLX_PYTHON=/Users/jan/ctt-python/bin/python3
```

Sla op. De eerste keer dat je met deze spraakherkenning opneemt, downloadt de app het
spraakmodel (ongeveer 3 GB). Dat kan enkele minuten duren. Doe die eerste opname dus thuis,
niet pas in de kerk.

De vertaling gaat ook bij deze manier via internet, met je OpenAI- of Anthropic-sleutel.

# De app starten en stoppen

Dit doe je elke keer dat je de app wilt gebruiken.

1. Open een terminal in de map van de app (zie stap 3 van de installatie).
2. Typ:

   ```
   npm run dev
   ```

3. Wacht tot er een regel verschijnt met `serving on port 5001`.
4. Open Chrome en ga naar <http://localhost:5001>.

Laat het terminalvenster open zolang je de app gebruikt: dat venster *is* de app. Het
browservenster mag je gerust sluiten en opnieuw openen.

**Stoppen:** klik in het terminalvenster en druk op **Ctrl+C** (ook op de Mac: de Control-toets,
niet Cmd). Daarna kun je het venster sluiten.

De eerste keer vraagt de computer misschien of *Node* verbindingen van het netwerk mag
ontvangen. Kies **Toestaan** (op Windows: sta het toe voor **privénetwerken**). Anders kunnen
telefoons niet meelezen.

# De eerste keer instellen

Klik in de app op het tandwiel rechtsboven om de instellingen te openen. Controleer:

- **General > API keys:** je sleutels staan hier al ingevuld, de app haalt ze uit het
  `.env`-bestand.
- **General > Languages:** *Speaking in* Nederlands, *Translate to* Engels.
- **General > Speech recognition:** kies **OpenAI Whisper**, of op een Mac met Apple-chip
  **Local Whisper (MLX)** als je stap 6 hebt gedaan.
- **General > Microphone:** kies de microfoon die je gebruikt. Laat je *System default*
  staan, dan neemt de app op met de microfoon die de computer op dat moment kiest, en dat is
  niet altijd de goede.
- **Sermon mode > Translation:** kies wie vertaalt: *OpenAI GPT-4o-mini* of *Claude Haiku*.

De instellingen worden bewaard in de browser. Je hoeft ze maar één keer te doen.

De eerste keer dat je opneemt, vraagt Chrome toestemming voor de microfoon. Klik op
**Toestaan**. Op de Mac moet Chrome soms ook toestemming krijgen in
**Systeeminstellingen > Privacy en beveiliging > Microfoon**.

# Een preek vertalen

## Opnemen

1. Klik op **Record**. De app begint te luisteren.
2. Na enkele seconden verschijnt links de Nederlandse tekst. Zodra een blok tekst af is,
   verschijnt rechts de Engelse vertaling.
3. Met **Pause** stop je tijdelijk (bijvoorbeeld tijdens het zingen). Klik nog eens om verder
   te gaan. Wat tijdens de pauze gezegd wordt, wordt niet opgeschreven.
4. Met **Stop** beëindig je de opname. De laatste woorden worden nog afgemaakt.

De balk onder de knoppen laat zien welke microfoon je gebruikt en hoe hard het geluid binnenkomt.
Een melding als *Too quiet* of *No sound from this microphone* betekent dat de app je niet
goed hoort.

## Tekst verbeteren

- **Nederlandse tekst (links):** klik erin en typ. Na een verbetering wordt de rij vanzelf opnieuw
  vertaald, behalve als je de Engelse tekst van die rij al zelf hebt aangepast.
- **Engelse tekst (rechts):** klik erin en typ. Wat je typt gaat direct naar de telefoons van
  de luisteraars. De app neemt jouw verbeteringen ook als voorbeeld voor de volgende
  vertalingen.
- **Return** bewaart de rij en springt naar dezelfde kolom in de volgende rij.
  **Shift+Return** maakt een nieuwe regel binnen dezelfde rij.
- **Add row** maakt een lege rij waarin je zelf tekst typt, ook zonder microfoon.

## Handige knoppen

- **Auto-translate** zet het automatisch vertalen aan of uit. Staat het uit, dan typ je zelf
  de vertaling.
- **Service:** vul vóór de dienst de titel van de preek, de Bijbelgedeelten en
  bijzondere namen in. De app herkent die woorden dan beter en vertaalt ze correct. Dit
  geldt alleen voor deze dienst.
- **Add lyrics** voegt de tekst van een lied toe (via een link uit AllSongs).
- **Bijbelteksten:** wordt een Bijbelgedeelte voorgelezen, dan zet de app de officiële
  Engelse tekst neer in plaats van een eigen vertaling. Dit stel je in onder
  **Sermon mode > Scripture quotes**.

# Luisteraars op hun telefoon

Luisteraars lezen de Engelse vertaling live mee op hun telefoon.

1. Zorg dat de computer en de telefoons op **hetzelfde wifi-netwerk** zitten.
2. Klik in de app op **Listeners**. Je ziet een adres, bijvoorbeeld `http://192.168.1.42:5001`.
3. De luisteraars typen dat adres in de browser van hun telefoon. Ze hoeven niets te
   installeren of in te loggen.

De luisteraars zien alleen de Engelse tekst, en alleen rijen die klaar zijn. Een rij die je
achteraf verbetert, wordt op hun scherm schuin gedrukt.

Met de knop **Sending to listeners** zet je het doorsturen even stil (de knop toont dan
*Listeners paused*). Zet je het weer aan, dan krijgen de telefoons alles wat je intussen
schreef in één keer.

**Werkt het niet in de kerk?** Gastwifi van kerken laat apparaten vaak niet met elkaar
praten. Daar kan de app niets aan doen. Test het daarom vooraf op de wifi van de kerk. Werkt
het niet, maak dan met je telefoon of computer een eigen hotspot en laat de luisteraars
daarop aansluiten.

Iedereen op hetzelfde wifi-netwerk die het adres kent, kan meelezen. Het is dus niet geschikt
voor vertrouwelijke tekst.

# Na de dienst

- **De Engelse tekst bewaren:** na **Stop** bewaart de app de Engelse tekst automatisch als
  bestand in de map `data/transcripts` in de map van de app. Met **Save .md** download je
  hetzelfde bestand via de browser.
- **Per ongeluk de pagina gesloten of herladen?** De app bewaart de tekst elke paar seconden
  in de browser. Open de pagina opnieuw en klik op **Restore** om verder te gaan.
- Sluit daarna de app af met **Ctrl+C** in het terminalvenster.

# Problemen oplossen

**De pagina `localhost:5001` opent niet.**
Kijk of het terminalvenster nog open is en `serving on port ...` toont. Staat daar een ander
getal dan 5001, gebruik dan dat getal in het adres.

**De app hoort niets.**
Controleer in de geluidsbalk welke microfoon gekozen is en of het niveau beweegt als iemand
praat. Kies de goede microfoon via de microfoonnaam in die balk. Op de Mac: geef Chrome
toegang tot de microfoon in Systeeminstellingen.

**Er verschijnt een rode, knipperende melding over de microfoon.**
De microfoon is weggevallen (losgekoppeld, of de batterij van een draadloze zender is leeg).
De app neemt verder op met de ingebouwde microfoon. Los het probleem op, kies eventueel
**Switch back to ...** en klik op **OK, I've seen this**.

**Er komt geen vertaling.**
Kijk onder **General > API keys** of de sleutel klopt, en of er nog tegoed op je account
staat bij OpenAI of Anthropic.

**De telefoons krijgen niets binnen.**
Zitten ze op hetzelfde wifi-netwerk? Heb je de vraag over netwerkverbindingen toegestaan
(zie *De app starten en stoppen*)? Staat de knop op *Sending to listeners*? Lees ook het stuk
over gastwifi hierboven.

**Je wilt een nieuwere versie van de app.**
Download de ZIP opnieuw (installatie stap 2), zet je `.env`-bestand over naar de nieuwe map
en doe stap 4 (`npm install`) opnieuw.
