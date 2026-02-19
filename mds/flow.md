This is how I envision the use case of the final implementation...

First a model is chosen. Models are saved under ```src/data/models``` then based on the chose model, its weights etc are loaded as well as the ```evaluation.json``` file associated with it. 

From the ```evaluation.json``` file we see what features we need for each track. 

Then we choose an audio src. And create some sort of queue system. [here we can do many things later down the line into matchin cue points for smooth transitions etc.]

Based on each audio file, if we have the pickle file for it great, else use the extractor to extract the features from the ```evaluation.json``` file. (we only extract whats needed to speed the process up). -> This should be done using multiprocessing so that files later down in the queue are processed asynchronously.

---

The way I envision it being is the following: 

Screen brocken into 3 main pieces

On the left is the current track, on the right the next track. And then as a side right bar is the queue of songs to come up.

Below the playing tracks we have their mp3 signature, as well as a graph of the potential entry cues and exit cues same as that on the playground. 

By default BeatBot chooses the points, but here I want to allow the user to shift them based on signature and other graphs. 

Somewhere on the screen (maybe space bar triggered or hotkeyed) there is a trigger transition now button that feeds the next 10s of the song to the model to find the optimum exit point from that position.
