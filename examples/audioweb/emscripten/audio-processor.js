// audio-processor.js - AudioWorklet processor for handling audio processing
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Communication channel with main thread
    this.port.onmessage = this.handleMessage.bind(this);
    
    // Flag to indicate if WASM module is ready
    this.moduleReady = false;
    
    // Buffer for audio processing
    this.buffer = null;
    this.dataPtr = null;
  }

  handleMessage(event) {
    if (event.data.type === 'init') {
      // Store references to the data pointer
      this.dataPtr = event.data.dataPtr;
      
      // We'll create our own buffer for processing - no longer using WASM memory directly
      if (!this.buffer) {
        // Default size if we don't have memory info yet
        const defaultSize = 2048;
        this.buffer = new Float32Array(defaultSize);
      }
      
      this.moduleReady = true;
      
      // Send acknowledgment back
      this.port.postMessage({ type: 'initialized' });
    } 
    else if (event.data.type === 'memoryBuffer') {
      // This message contains information about the memory buffer
      this.byteOffset = event.data.byteOffset;
      this.length = event.data.length;
      
      // Create a buffer of the right size
      this.buffer = new Float32Array(this.length);
      
      console.log("Audio processor received memory info:", {
        byteOffset: this.byteOffset,
        length: this.length
      });
    }
    else if (event.data.type === 'audioData') {
      // Received actual audio data from the main thread
      if (event.data.audio && event.data.audio.length > 0) {
        // Update our local buffer with the new audio data
        if (!this.buffer || this.buffer.length !== event.data.audio.length) {
          this.buffer = new Float32Array(event.data.audio.length);
        }
        
        // Copy the new audio data
        this.buffer.set(event.data.audio);
      }
    }
  }

  process(inputs, outputs, parameters) {
    // Early return if not initialized
    if (!this.moduleReady) {
      // Fill with silence
      const output = outputs[0];
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].fill(0);
      }
      
      // Request initialization
      this.port.postMessage({ type: 'requestSetup' });
      return true;
    }

    const output = outputs[0];
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    
    // Add debug output occasionally (every 500 frames)
    if (!this.frameCount) this.frameCount = 0;
    this.frameCount++;
    if (this.frameCount % 500 === 0) {
      console.log("AudioProcessor active, buffer status:", {
        hasBuffer: !!this.buffer,
        bufferLength: this.buffer ? this.buffer.length : 0,
        moduleReady: this.moduleReady
      });
    }
    
    // Check if our buffer is ready
    if (!this.buffer) {
      // Fill with silence if buffer isn't available
      left.fill(0);
      if (right !== left) {
        right.fill(0);
      }
      
      // Request setup again
      this.port.postMessage({ type: 'requestSetup' });
      return true;
    }
    
    try {
      // Use our local buffer instead of trying to access WASM memory directly
      const result = this.buffer;
      
      // Deinterleave the audio data - use a safe approach
      const maxSamples = Math.min(left.length, Math.floor(result.length / 2));
      for (let i = 0; i < maxSamples; i++) {
        left[i] = result[i * 2] || 0;
        right[i] = result[i * 2 + 1] || 0;
      }
      
      // If we don't have enough data, fill the rest with silence
      for (let i = maxSamples; i < left.length; i++) {
        left[i] = 0;
        right[i] = 0;
      }
      
      // Now request new audio data for next time
      this.port.postMessage({ 
        type: 'audioNeeded', 
        frameSize: left.length
      });
    } catch (e) {
      console.error("Error accessing WASM memory:", e);
      // Fill with silence on error
      left.fill(0);
      if (right !== left) {
        right.fill(0);
      }
      
      // Request memory again
      this.port.postMessage({ type: 'requestMemory' });
    }
    
    // Post message to main thread to request more audio data
    this.port.postMessage({ type: 'audioNeeded', frameSize: left.length });
    
    // Return true to keep the processor alive
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
