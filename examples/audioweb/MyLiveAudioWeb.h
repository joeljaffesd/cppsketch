#include "LiveAudioWeb.h"
#include "Biquad.h"
#include <math.h>

using namespace std;


class MyLiveAudioWeb : public LiveAudioWeb {
public:
	MyLiveAudioWeb() {}

	struct SinOsc {
		double phase = 0;
		double freq = 220;

		SinOsc() {}
		// 
		float getSample() {
			phase += freq * M_PI * 2.0 / 44100.f;
			return sin(phase);
		}
	};

	SinOsc osc;

	void audioOut(float *samples, int length, int numChans) override {
		float out;
		for(int i = 0; i < length; i++) {
			out = osc.getSample();
			samples[i*2] = out;
			samples[i*2+1] = out;
		}
	}	
};