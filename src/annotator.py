import ipywidgets as widgets
from IPython.display import display, Audio, clear_output
import os
import json

def get_time_seconds(time_str):
    """Converts mm:ss or seconds string to float seconds"""
    if not time_str:
        return 0.0
    try:
        time_str = str(time_str).strip()
        if ":" in time_str:
            parts = time_str.split(":")
            m = float(parts[0])
            s = float(parts[1])
            return m * 60 + s
        return float(time_str)
    except:
        return 0.0

class AnnotatorTool:
    def __init__(self, audio_dir="../data/custom/audio", annotations_dir="../data/custom/annotations"):
        self.audio_dir = audio_dir
        self.annotations_dir = annotations_dir
        
        # Sort files to keep order consistent
        if os.path.exists(self.annotations_dir):
            self.files = sorted([f for f in os.listdir(self.annotations_dir) if f.endswith(".jams")])
        else:
            self.files = []
            print(f"Warning: Annotations directory not found at {self.annotations_dir}")

        self.current_index = 0
        self.jams_data = None
        self.jams_path = None
        
        # UI Elements
        self.out_debug = widgets.Output() # For status messages
        
        self.lbl_title = widgets.Label(value="Initializing...", style={'font_weight': 'bold', 'font_size': '16px'})
        self.audio_output = widgets.Output() # To hold the audio player
        
        # Helper to create styled input
        def create_input(label):
            return widgets.Text(
                description=label, 
                placeholder="mm:ss or sec",
                style={'description_width': 'initial'},
                layout=widgets.Layout(width='200px')
            )

        self.txt_in1 = create_input("IN 1:")
        self.txt_in2 = create_input("IN 2:")
        self.txt_in3 = create_input("IN 3:")
        
        self.txt_out1 = create_input("OUT 1:")
        self.txt_out2 = create_input("OUT 2:")
        self.txt_out3 = create_input("OUT 3:")
        
        self.btn_save = widgets.Button(
            description="Save & Next", 
            button_style='success', # Green
            icon='check'
        )
        self.btn_save.on_click(self.on_save)
        
        self.btn_skip = widgets.Button(
            description="Skip", 
            button_style='warning', # Orange
            icon='forward'
        )
        self.btn_skip.on_click(self.on_skip)

        # Layout
        self.ui = widgets.VBox([
            widgets.HTML("<h2>My Custom Annotation Tool</h2>"),
            self.lbl_title,
            self.audio_output,
            widgets.HTML("<i>Enter timestamps in <b>mm:ss</b> (e.g. 1:30.5) or raw seconds.</i>"),
            widgets.HTML("<hr>"),
            widgets.HBox([
                widgets.VBox([
                    widgets.HTML("<b>Entry Points (Intro)</b>"),
                    self.txt_in1, self.txt_in2, self.txt_in3
                ], layout=widgets.Layout(margin='0px 20px 0px 0px')),
                widgets.VBox([
                    widgets.HTML("<b>Exit Points (Outro)</b>"),
                    self.txt_out1, self.txt_out2, self.txt_out3
                ])
            ]),
            widgets.HTML("<br>"),
            widgets.HBox([self.btn_save, self.btn_skip]),
            self.out_debug
        ])
        
        # Start
        if self.files:
            self.find_next_unannotated()
        else:
            self.lbl_title.value = "No files found."

    def find_next_unannotated(self):
        with self.out_debug:
            print("Searching for next unannotated track...")
            
        found = False
        
        # Simple linear search from current position
        for i in range(len(self.files)):
            # Check files starting from 'current_index' wrapping around is usually complex, 
            # let's just search all, but ideally we want the "next" one.
            # We'll just prioritize sequential order.
            
            check_idx = i
            
            path = os.path.join(self.annotations_dir, self.files[check_idx])
            try:
                with open(path, 'r') as f:
                    data = json.load(f)
                
                # Check if data is "empty" (all times are 0.0)
                points = data['annotations'][0]['data']
                has_data = any(p['time'] > 0 for p in points)
                
                if not has_data:
                    self.current_index = check_idx
                    self.load_track(check_idx)
                    found = True
                    # Clear debug log once found
                    self.out_debug.clear_output()
                    return
            except:
                continue
        
        if not found and self.files:
            self.lbl_title.value = "All Tracks Annotated! Great job!"
            self.audio_output.clear_output()
            with self.out_debug:
                print("Complete.")

    def load_track(self, index):
        self.jams_path = os.path.join(self.annotations_dir, self.files[index])
        with open(self.jams_path, 'r') as f:
            self.jams_data = json.load(f)
            
        track_name = self.files[index].replace(".jams", "")
        self.lbl_title.value = f"Track {index+1}/{len(self.files)}: {track_name}"
        
        # Load Audio
        audio_path = os.path.join(self.audio_dir, track_name + ".mp3")
        self.audio_output.clear_output()
        
        # Update styling or content based on existence
        with self.audio_output:
            if os.path.exists(audio_path):
                # Display standard HTML5 audio player
                display(Audio(audio_path, autoplay=False))
            else:
                print(f"Error: Audio file not found at {audio_path}")

        # Clear inputs
        self.txt_in1.value = ""
        self.txt_in2.value = ""
        self.txt_in3.value = ""
        self.txt_out1.value = ""
        self.txt_out2.value = ""
        self.txt_out3.value = ""
        
    def on_save(self, b):
        # Validate inputs
        inputs = [self.txt_in1, self.txt_in2, self.txt_in3, 
                  self.txt_out1, self.txt_out2, self.txt_out3]
        
        # Update JSON structure
        points_data = self.jams_data['annotations'][0]['data']
        
        # We assume strict ordering: first 3 are IN, next 3 are OUT (from our blueprint script)
        # Verify length matches just in case
        if len(points_data) < 6:
            with self.out_debug:
                print(f"Error: JAMS file has {len(points_data)} points, expected 6.")
            return

        has_input = False
        for i, txt in enumerate(inputs):
            val = get_time_seconds(txt.value)
            points_data[i]['time'] = val
            if val > 0: has_input = True
            
        if not has_input:
             with self.out_debug:
                print("Warning: All values are 0. Use 'Skip' if you want to pass this track.")
                return

        # Save to disk
        try:
            with open(self.jams_path, 'w') as f:
                json.dump(self.jams_data, f, indent=2)
                
            # Log success
            with self.out_debug:
                print(f"Saved: {self.files[self.current_index]} ✓")
                
            # Move on
            if self.current_index < len(self.files) - 1:
                self.current_index += 1
                
            self.find_next_unannotated()
            
        except Exception as e:
            with self.out_debug:
                print(f"Save Error: {e}")

    def on_skip(self, b):
        with self.out_debug:
            print(f"Skipped.")
        if self.current_index < len(self.files) - 1:
            self.current_index += 1
            # We just load the next one regardless of annotation status to let user browse
            self.load_track(self.current_index)
        else:
            print("End of list.")
