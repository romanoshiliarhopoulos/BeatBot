# BeatBot

Work in Progress...


Project end goal: 

Given a user defined music queue, the goal of BeatBot is to transition from one song onto the next. More specifically, this is accomplished by choosing an exit cue on the current song and an entry cue on the next song, and applying some kind of transition. 

Additionally, I want a user to be able to trigger a transition within the next 10-15s of the current song and BeatBot find the "best exit cue" in that given timeframe. (Here techniques like fading vocals, while still keeping the beat going or other mixing techniques could help.)

Ideally the model will classify the following: 

- The "best" entry cue, along with 2 other alternatives. (Unless alternatives are chosen, mix happens at "best").
- The "best" exit cue, along with 2 other alternatives. (Unless alternatives are chosen, mix happens at "best").
- If user triggers, finds the optimal exit cue within the next 10-15s of current track. (Next entry already computed at this point.)

