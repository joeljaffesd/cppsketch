#!/bin/zsh

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
        echo "Executable not found at $EXECUTABLE_PATH"
        # Look for other executables in the current directory
        EXECUTABLE=$(find "." -maxdepth 1 -type f -perm +111 -not -name "*.sh" | head -1)
        
        if [ -n "$EXECUTABLE" ]; then
            echo "Found executable: $EXECUTABLE"
            echo "Running executable..."
            "$EXECUTABLE"
        else
            # Try looking in the build directory
            EXECUTABLE=$(find "./build" -type f -perm +111 -not -name "*.so" -not -name "*.dylib" -not -name "*.a" -not -path "*/CMakeFiles/*" | head -1)
            
            if [ -n "$EXECUTABLE" ]; then
                echo "Found executable in build directory: $EXECUTABLE"
                echo "Running executable..."
                "$EXECUTABLE"
            else
                echo "No executable found in current directory or build directory"
            fi
        fi
    fi
else
    echo "Build failed."
    exit 1
fi