#!/bin/bash

# Check if a filepath was provided
if [ $# -eq 0 ]; then
    echo "Error: No filepath provided."
    echo "Usage: ./run.sh <filepath>"
    exit 1
fi

# Get the directory of the provided filepath
FILEPATH="$1"
DIRNAME=$(dirname "$FILEPATH")

# Navigate to the directory
cd "$DIRNAME" || { echo "Error: Failed to navigate to $DIRNAME"; exit 1; }

echo "Building CMake project in $DIRNAME..."

# Run the CMake commands (equivalent to the tasks.json commands)
cmake -Bbuild && cmake --build build --config Release

# Check if the build was successful
if [ $? -eq 0 ]; then
    echo "Build completed successfully."
    
    # Get the executable name from the directory name - since we already changed directory
    EXECUTABLE_NAME=$(basename "$(pwd)")
    EXECUTABLE_PATH="./$EXECUTABLE_NAME"
    
    # Check if the executable exists and run it
    if [ -f "$EXECUTABLE_PATH" ] && [ -x "$EXECUTABLE_PATH" ]; then
        echo "Running $EXECUTABLE_NAME..."
        "$EXECUTABLE_PATH"
    else 
        echo "Executable not found!"
    fi
else
    echo "Build failed."
    exit 1
fi