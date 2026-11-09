---
title: "CTT.AY — User Manual"
subtitle: "Translating a live sermon, step by step"
lang: en-GB
---

# What is CTT.AY?

CTT.AY (*Contextual Transcriptions & Translations*, pronounced *"stay"*) listens to a sermon,
writes down what is said and translates it into English straight away.

The screen shows two columns side by side: the Dutch text on the left and the English
translation on the right. You can correct both during the sermon. People who don't speak
Dutch can follow the English live on their own phone, without installing an app.

The app runs on your own computer. You open it in a web browser, but it is not on the
internet: only devices on the same Wi-Fi network can read along.

This manual is for anyone installing and using the app for the first time. You don't need to
know how to program. You will type a few commands into a black window called the *terminal*.
Every command is written out in full below, so you can copy and paste it.

# What you need

## Which computer?

The current version is **made for a Mac with an Apple chip** (M1, M2, M3, M4 or newer). On
such a Mac, speech recognition can run entirely on the computer itself: free, without the
internet for that part, and without the audio leaving the computer.

If you **don't have a Mac with an Apple chip** (a Windows PC, or an older Mac with an Intel
processor), you can still use the app, but speech recognition then happens online, through
OpenAI. For that you need an **OpenAI API key** (see below).

| Computer | Speech recognition | Translation | You need |
|-------------|---------------------|-------------------|---------------------|
| Mac with Apple chip | On the Mac itself (free) or through OpenAI | OpenAI, Anthropic (Claude) or local | Node.js, Python; an API key for translation |
| Mac with Intel processor | Through OpenAI | OpenAI or Anthropic (Claude) | Node.js; OpenAI key |
| Windows PC | Through OpenAI | OpenAI or Anthropic (Claude) | Node.js; OpenAI key |

Not sure which Mac you have? Click the Apple logo at the top left and choose **About This
Mac**. If it says *Chip* "Apple M1" (or M2, M3, ...), you have an Apple chip. If it says
*Processor* with "Intel", you don't.

> **Note:** an Anthropic key (for Claude) on its own is not enough. Claude translates, but it
> cannot recognise speech. Without a Mac with an Apple chip you always need an OpenAI key. An
> Anthropic key is an optional extra for translation.

## Everything else

- **Google Chrome** (or Microsoft Edge). Other browsers work less well.
- **A microphone.** The built-in microphone works, but a separate microphone or a connection
  to the church's sound system gives much better text.
- **Internet**, for translation and (without an Apple chip) for speech recognition.
- **An API key** from OpenAI and/or Anthropic. An API key is a kind of password that lets the
  app use OpenAI's or Anthropic's services on your behalf. You pay for what you use.
- **About half an hour** for the first installation.

## Getting an API key

**OpenAI** (speech recognition and translation):

1. Go to <https://platform.openai.com> and create an account.
2. Under *Billing*, add a payment method and some credit (for example 10 dollars).
3. Go to *API keys* and click **Create new secret key**.
4. Copy the key (it starts with `sk-`) and keep it somewhere safe. It is only shown once.

**Anthropic** (optional, translation with Claude):

1. Go to <https://console.anthropic.com> and create an account.
2. Add credit under *Billing*.
3. Create a key under *API Keys* (it starts with `sk-ant-`) and keep it safe.

**What does it cost?** OpenAI's speech recognition costs about 0.6 US cents per minute, so
roughly 35 cents per hour. Translation usually adds a few cents per hour. For a one-hour
service, expect less than a dollar.

Never give your API key to anyone: whoever has it can use the service at your expense.

# Installation (once)

You do these steps once per computer.

## Step 1: Install Node.js

Node.js is the program the app runs on.

1. Go to <https://nodejs.org>.
2. Download the version marked **LTS** (the recommended version).
3. Open the downloaded file and follow the installer. You can keep all the default choices.

## Step 2: Download the app

1. Go to <https://github.com/yartow/LiveTranslation>.
2. Click the green **Code** button, then **Download ZIP**.
3. Unzip the file (double-click it on a Mac; on Windows, right-click and choose
   **Extract All**).
4. Move the unzipped folder (`LiveTranslation-main`) into your **Documents** folder.

## Step 3: Open a terminal in the app's folder

The terminal is a window where you type commands. It has to be "in" the app's folder.

**On a Mac:**

1. Open **Terminal** (press Cmd+Space and search for "Terminal").
2. Type `cd` followed by a space. Don't press Return yet.
3. Drag the `LiveTranslation-main` folder from the Finder into the terminal window. Its path
   appears after `cd`.
4. Press Return.

**On Windows:**

1. Open the `LiveTranslation-main` folder in File Explorer.
2. Click in the address bar at the top (where the path is shown), type `cmd` and press Enter.
3. A black window opens that is already in the right folder.

## Step 4: Install the app's components

Type in the terminal:

```
npm install
```

and press Return/Enter. This takes a few minutes. A lot of text appears; messages containing
*warn* or *vulnerabilities* can be ignored.

Does the terminal say *"npm: command not found"* or *"npm is not recognized"*? Close the
terminal window, open it again (step 3) and try once more. If that doesn't help, step 1 did
not succeed.

## Step 5: Enter your API keys

The app reads your keys from a file called `.env` in the app's folder.

**On a Mac**, type in the terminal:

```
cp .env.example .env
open -e .env
```

**On Windows**, type in the terminal:

```
copy .env.example .env
notepad .env
```

A text file opens. Find these lines and put your own key after the `=` sign, with no spaces
and no quotation marks:

```
OPENAI_API_KEY=sk-your-own-key
ANTHROPIC_API_KEY=sk-ant-your-own-key
```

No Anthropic key? Then empty that line: `ANTHROPIC_API_KEY=`. Leave the rest of the file as
it is. Save and close the file.

## Step 6 (Mac with Apple chip only): speech recognition on the Mac itself

This step is optional. Skip it if you use OpenAI for speech recognition.

Speech recognition on the Mac itself needs Python with the `mlx-whisper` component. Type in
the terminal, one line at a time:

```
python3 -m venv ~/ctt-python
~/ctt-python/bin/pip install mlx-whisper
echo ~/ctt-python/bin/python3
```

- Does the Mac offer to install **developer tools** after the first line? Click *Install*,
  wait until it is done and type the lines again.
- The last line prints a path, for example `/Users/jan/ctt-python/bin/python3`. Copy it.

Open the `.env` file again (`open -e .env`), find the line `MLX_PYTHON=` and paste the path
after it:

```
MLX_PYTHON=/Users/jan/ctt-python/bin/python3
```

Save. The first time you record with this speech recognition, the app downloads the speech
model (about 3 GB). That can take several minutes, so make that first recording at home, not
at church.

Translation still goes over the internet with this setup, using your OpenAI or Anthropic key.

# Starting and stopping the app

You do this every time you want to use the app.

1. Open a terminal in the app's folder (see step 3 of the installation).
2. Type:

   ```
   npm run dev
   ```

3. Wait until a line appears with `serving on port 5001`.
4. Open Chrome and go to <http://localhost:5001>.

Keep the terminal window open for as long as you use the app: that window *is* the app. You
can close and reopen the browser window whenever you like.

**To stop:** click in the terminal window and press **Ctrl+C** (on a Mac too: the Control key,
not Cmd). Then you can close the window.

The first time, the computer may ask whether *Node* may accept incoming network connections.
Choose **Allow** (on Windows: allow it for **private networks**). Otherwise phones cannot read
along.

# Setting up the first time

In the app, click the gear icon at the top right to open the settings. Check:

- **General > API keys:** your keys are already filled in; the app takes them from the `.env`
  file.
- **General > Languages:** *Speaking in* Dutch, *Translate to* English.
- **General > Speech recognition:** choose **OpenAI Whisper**, or on a Mac with an Apple chip
  **Local Whisper (MLX)** if you did step 6.
- **General > Microphone:** choose the microphone you use. If you leave it on *System default*,
  the app records from whichever microphone the computer picks at that moment, which is not
  always the right one.
- **Sermon mode > Translation:** choose who translates: *OpenAI GPT-4o-mini* or *Claude Haiku*.

The settings are kept in the browser. You only need to do this once.

The first time you record, Chrome asks for permission to use the microphone. Click **Allow**.
On a Mac, Chrome sometimes also needs permission under **System Settings > Privacy &
Security > Microphone**.

# Translating a sermon

## Recording

1. Click **Record**. The app starts listening.
2. After a few seconds the Dutch text appears on the left. As soon as a block of text is
   complete, the English translation appears on the right.
3. **Pause** stops listening for a while (for example during singing). Click it again to
   continue. Whatever is said during the pause is not written down.
4. **Stop** ends the recording. The last words are still finished.

The bar below the buttons shows which microphone is in use and how loud the sound comes in. A
message such as *Too quiet* or *No sound from this microphone* means the app can't hear you
properly.

## Correcting text

- **Dutch text (left):** click in it and type. After a correction the row is translated again
  automatically, unless you have already changed that row's English yourself.
- **English text (right):** click in it and type. What you type goes straight to the
  listeners' phones. The app also uses your corrections as examples for the translations that
  follow.
- **Return** saves the row and jumps to the same column in the next row. **Shift+Return**
  starts a new line within the same row.
- **Add row** creates an empty row to type text into yourself, even without a microphone.

## Useful buttons

- **Auto-translate** turns automatic translation on or off. When it is off, you type the
  translation yourself.
- **Service:** before the service, fill in the sermon title, the Bible passages and any
  unusual names. The app then recognises those words better and translates them correctly.
  This only applies to this service.
- **Add lyrics** adds the words of a song (from an AllSongs link).
- **Bible passages:** when a passage is read aloud, the app shows the official English text
  instead of its own translation. You set this up under **Sermon mode > Scripture quotes**.

# Listeners on their phones

Listeners read the English translation live on their phones.

1. Make sure the computer and the phones are on **the same Wi-Fi network**.
2. Click **Listeners** in the app. You'll see an address, for example
   `http://192.168.1.42:5001`.
3. Listeners type that address into their phone's browser. They don't need to install
   anything or log in.

Listeners see only the English text, and only rows that are finished. A row you correct
afterwards is shown in italics on their screen.

The **Sending to listeners** button pauses sending for a while (the button then shows
*Listeners paused*). When you turn it back on, the phones receive everything you wrote in the
meantime at once.

**Doesn't it work at church?** Church guest Wi-Fi often prevents devices from talking to each
other. The app can't do anything about that, so test it on the church's Wi-Fi beforehand. If
it doesn't work, create your own hotspot with your phone or computer and have the listeners
join that.

Anyone on the same Wi-Fi network who knows the address can read along, so it is not suitable
for confidential text.

# After the service

- **Keeping the English text:** after **Stop**, the app automatically saves the English text
  as a file in the `data/transcripts` folder inside the app's folder. **Save .md** downloads
  the same file through the browser.
- **Closed or reloaded the page by accident?** The app saves the text in the browser every
  few seconds. Open the page again and click **Restore** to carry on.
- Then shut the app down with **Ctrl+C** in the terminal window.

# Troubleshooting

**The page `localhost:5001` doesn't open.**
Check that the terminal window is still open and shows `serving on port ...`. If it shows a
number other than 5001, use that number in the address.

**The app hears nothing.**
In the audio bar, check which microphone is selected and whether the level moves when someone
speaks. Choose the right microphone by clicking its name in that bar. On a Mac, give Chrome
access to the microphone in System Settings.

**A red, flashing warning about the microphone appears.**
The microphone dropped out (unplugged, or a wireless transmitter's battery ran out). The app
carries on recording with the built-in microphone. Fix the problem, choose **Switch back to
...** if offered, and click **OK, I've seen this**.

**No translation appears.**
Check under **General > API keys** that the key is right, and that your OpenAI or Anthropic
account still has credit.

**The phones receive nothing.**
Are they on the same Wi-Fi network? Did you allow the network connection question (see
*Starting and stopping the app*)? Is the button set to *Sending to listeners*? Also read the
part about guest Wi-Fi above.

**You want a newer version of the app.**
Download the ZIP again (installation step 2), move your `.env` file to the new folder and run
step 4 (`npm install`) again.
