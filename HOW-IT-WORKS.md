# How Gaucho Pass works

This explains the prototype in plain language, for our report. It covers how the rotating codes work, why screenshots and reused codes fail, how a lost phone is handled, and what a real UCSB rollout would need.

Gaucho Pass is a student prototype. It is not affiliated with UC Santa Barbara, and all of its data is made up.

## The idea in one paragraph

A plastic access card carries a number that never changes, so anyone who copies it can use it. Gaucho Pass replaces the fixed number with a QR code that changes every 30 seconds. The phone makes each code from a secret only that phone and the server know. A scanner reads the code and asks the server whether to let the person in. The server is the only thing that decides.

## How the rotating codes work

When a student's account is created, the server generates a long random secret for them (20 random bytes). After the student signs in, the server sends that secret to their phone, once, over an encrypted connection. Only the student's own secret is ever sent to them.

Every 30 seconds, the phone combines two things:

- the secret, and
- the current time, rounded down to the nearest 30 seconds.

It runs them through a standard formula and gets a 6-digit code. This is the same method that authenticator apps use for two-step login (it is called TOTP). The QR code on screen is just the student's perm number and that 6-digit code.

Because the code depends on the time, the phone does not need the internet to make it. It works in a basement or in airplane mode. The scanner is the part that needs a connection.

The phone stores the secret as a locked key. The app can ask the browser to make a code with it, but nothing can read the secret itself back out.

## What happens when a code is scanned

1. The scanner's camera reads the QR code and sends its contents, plus the scanner's location, to the server.
2. The server checks that the request comes from a signed-in scanner account and that this scanner is not sending too many requests.
3. The server looks up the student's secret and works out what the code should be right now. It also accepts the code just before and just after, in case the phone's clock is a little off.
4. If the code matches, the server checks the rest: is the ID active, does this student have access here, do they have a meal swipe left.
5. The server records the scan and answers "granted" or "denied" with a reason. The scanner shows a green or red screen with the student's photo so staff can match the face.

The scanner never sees a secret. It cannot make a valid code, and it cannot approve a scan on its own. If the scanner is offline, it shows "Can't verify" and lets nobody in.

## Why a screenshot fails

A code is shown for 30 seconds. To allow for clocks that are slightly off, the server accepts it for up to 30 seconds after that. So a screenshot is useless about a minute after it was taken, and the scanner says "Code expired" and how long ago it stopped working.

One honest limit: a screenshot that reaches a scanner inside that minute, before the real owner scans, would work once. Rotation limits how long a copy lasts. The next rule is what stops it being used more than once.

## Why a reused code fails

Each code can be accepted exactly once, anywhere. The server keeps a list of used codes, and the database itself refuses to store the same student and time window twice. This is one shared list for every scanner, so a code used at the Rec Cen is dead at the library a second later.

We tested this by sending the same code from ten places at the same moment. Exactly one is granted.

## Why a forged code fails

A code is 6 digits, and at any moment only three codes are valid for a student. A random guess has a 3 in 1,000,000 chance. After 10 wrong codes for the same student within 5 minutes, the server stops accepting guesses for that student for a while. A scanner account is also limited to 30 scans a minute.

When a code is wrong, the server does not say whose ID it was aimed at. The scanner gets a name and photo only when the code proves the person is who they claim to be.

## How a lost phone is handled

1. The student signs in on any other device, such as a friend's phone or a library computer, and taps "Report my ID lost".
2. The server immediately does three things. It marks the ID as lost. It throws away the old secret and makes a new one, so every code the lost phone can ever produce is now wrong. And it blocks every other device signed in to that account.
3. If someone tries the lost phone at a scanner, they get a red "Card deactivated" screen. The lost phone signs itself out the next time it is online.
4. When the student is ready, they tap "Reactivate". The device in their hand receives the new secret and starts showing working codes. The lost phone never receives it. If it is tried later, the scanner recognises it as a deactivated device.

An admin can also deactivate any ID. In that case only an admin can turn it back on.

Compare this with a plastic card: a lost card keeps working until someone at an office turns it off, and the student has to pay for and wait for a new one.

## What is stored where

| Place | What it holds |
|---|---|
| The student's phone | That student's own card details and their own locked key. Nothing about anyone else. |
| The scanner | Nothing secret. It holds a staff sign-in and the location it is set to. |
| The server | Everyone's secrets, the list of used codes, the scan log, meal swipes and guest passes. |

The database is set up so that each student can read only their own row, scanners cannot read student records at all, and nobody can read the secrets table directly. Every change, such as reporting an ID lost, goes through a server function that first checks who is asking.

## The extras

- **Meal swipes.** A counted meal plan loses one swipe per dining commons scan and refills each Monday. At zero, the dining commons says no, but the Rec Cen and library still work.
- **Guest passes.** A student can make a pass for a friend. It works for one scan or one hour, whichever comes first, and only at the kind of place it was made for. The server stores only a fingerprint of the pass, not the pass itself. Reporting the ID lost cancels unused passes.
- **Admin dashboard.** A live log of every scan from every scanner, with the reason for each denial, counts per location, and buttons to deactivate or reactivate an ID.
- **Scan speed.** Each scan records two times: from the student opening their ID to the server's answer, and from the scanner reading the code to the answer on screen. The Stats screen shows the typical (median) values. To compare with a plastic card, time a batch of real swipes with a stopwatch and put the two numbers side by side.

## What a real UCSB rollout would need

This prototype shows that the idea works. Turning it into something the campus could rely on would take the following.

1. **Real readers.** We used phones as scanners. A real system needs fixed readers at doors and registers. They also need a way to keep working when the network is down. Our prototype refuses everyone when the scanner is offline, which is safe but would stop a dinner line.
2. **Integration with the campus card system.** Meal plans, door permissions and balances already live in the university's card system; our proposal names Transact. Gaucho Pass would have to read and update those records instead of keeping its own copy.
3. **Apple Wallet and Google Wallet.** A QR code needs the phone unlocked and the app open. A Wallet pass uses tap-to-enter (NFC), keeps its key in the phone's secure hardware, and can keep working for a while after the battery runs low. Offering one requires agreements with Apple and Google and readers that support it. Our "Add to Wallet" button shows the design only.
4. **Campus sign-in.** Students would sign in with their UCSB account and two-step login, not a separate password.
5. **A pilot in one building.** Start with one dining commons for one quarter, with the plastic card still working. Measure scan time, failed scans, lost-phone reports and what students and staff say, then decide whether to expand.
6. **Privacy rules.** A scan log shows where a student was and when. The university would need to decide how long to keep it, who can see it, and how students can see their own history.
7. **A fallback.** Some students have no smartphone, and batteries die. The plastic card, or a desk that can check ID, has to remain.
8. **An independent security review.** We tested the attacks we could think of. A real deployment needs professionals trying to break it.

## Limits of this prototype

- It is a web app, so the secret is protected by the browser, not by the phone's secure chip as a Wallet pass would be.
- Anyone holding an unlocked, signed-in phone can show its code until the owner reports it lost. A real version would ask for Face ID or a passcode first.
- A dishonest scanner account could lock a student out for a few minutes by sending wrong codes for them on purpose. Every attempt is logged with the scanner's account, so it would be noticed.
- The test accounts are shared, so two people signed in as the same student show the same codes.
- It runs on a free hosting plan that pauses after a week without use.
