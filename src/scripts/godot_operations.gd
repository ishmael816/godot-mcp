#!/usr/bin/env -S godot --headless --script
extends SceneTree

# Debug mode flag
var debug_mode = false

func _init():
    var args = OS.get_cmdline_args()
    
    # Check for debug flag
    debug_mode = "--debug-godot" in args
    
    # Find the script argument and determine the positions of operation and params
    var script_index = args.find("--script")
    if script_index == -1:
        log_error("Could not find --script argument")
        quit(1)
    
    # The operation should be 2 positions after the script path (script_index + 1 is the script path itself)
    var operation_index = script_index + 2
    # The params should be 3 positions after the script path
    var params_index = script_index + 3
    
    if args.size() <= params_index:
        log_error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
        log_error("Not enough command-line arguments provided.")
        quit(1)
    
    # Log all arguments for debugging
    log_debug("All arguments: " + str(args))
    log_debug("Script index: " + str(script_index))
    log_debug("Operation index: " + str(operation_index))
    log_debug("Params index: " + str(params_index))
    
    var operation = args[operation_index]
    var params_json = args[params_index]
    
    log_info("Operation: " + operation)
    log_debug("Params JSON: " + params_json)
    
    # Parse JSON using Godot 4.x API
    var json = JSON.new()
    var error = json.parse(params_json)
    var params = null
    
    if error == OK:
        params = json.get_data()
    else:
        log_error("Failed to parse JSON parameters: " + params_json)
        log_error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
        quit(1)
    
    if not params:
        log_error("Failed to parse JSON parameters: " + params_json)
        quit(1)
    
    log_info("Executing operation: " + operation)
    
    match operation:
        "create_scene":
            create_scene(params)
        "add_node":
            add_node(params)
        "load_sprite":
            load_sprite(params)
        "export_mesh_library":
            export_mesh_library(params)
        "save_scene":
            save_scene(params)
        "get_uid":
            get_uid(params)
        "resave_resources":
            resave_resources(params)
        "capture_screenshot":
            capture_screenshot(params)
        "attach_script":
            attach_script(params)
        "connect_signal":
            connect_signal(params)
        "set_node_property":
            set_node_property(params)
        "delete_node":
            delete_node(params)
        "build_csharp_project":
            build_csharp_project(params)
        _:
            log_error("Unknown operation: " + operation)
            quit(1)
    
    quit()

# Logging functions
func log_debug(message):
    if debug_mode:
        print("[DEBUG] " + message)

func log_info(message):
    print("[INFO] " + message)

func log_error(message):
    printerr("[ERROR] " + message)

# Get a script by name or path
func get_script_by_name(name_of_class):
    if debug_mode:
        print("Attempting to get script for class: " + name_of_class)
    
    # Try to load it directly if it's a resource path
    if ResourceLoader.exists(name_of_class, "Script"):
        if debug_mode:
            print("Resource exists, loading directly: " + name_of_class)
        var script = load(name_of_class) as Script
        if script:
            if debug_mode:
                print("Successfully loaded script from path")
            return script
        else:
            printerr("Failed to load script from path: " + name_of_class)
    elif debug_mode:
        print("Resource not found, checking global class registry")
    
    # Search for it in the global class registry if it's a class name
    var global_classes = ProjectSettings.get_global_class_list()
    if debug_mode:
        print("Searching through " + str(global_classes.size()) + " global classes")
    
    for global_class in global_classes:
        var found_name_of_class = global_class["class"]
        var found_path = global_class["path"]
        
        if found_name_of_class == name_of_class:
            if debug_mode:
                print("Found matching class in registry: " + found_name_of_class + " at path: " + found_path)
            var script = load(found_path) as Script
            if script:
                if debug_mode:
                    print("Successfully loaded script from registry")
                return script
            else:
                printerr("Failed to load script from registry path: " + found_path)
                break
    
    printerr("Could not find script for class: " + name_of_class)
    return null

# Instantiate a class by name
func instantiate_class(name_of_class):
    if name_of_class.is_empty():
        printerr("Cannot instantiate class: name is empty")
        return null
    
    var result = null
    if debug_mode:
        print("Attempting to instantiate class: " + name_of_class)
    
    # Check if it's a built-in class
    if ClassDB.class_exists(name_of_class):
        if debug_mode:
            print("Class exists in ClassDB, using ClassDB.instantiate()")
        if ClassDB.can_instantiate(name_of_class):
            result = ClassDB.instantiate(name_of_class)
            if result == null:
                printerr("ClassDB.instantiate() returned null for class: " + name_of_class)
        else:
            printerr("Class exists but cannot be instantiated: " + name_of_class)
            printerr("This may be an abstract class or interface that cannot be directly instantiated")
    else:
        # Try to get the script
        if debug_mode:
            print("Class not found in ClassDB, trying to get script")
        var script = get_script_by_name(name_of_class)
        if script is GDScript:
            if debug_mode:
                print("Found GDScript, creating instance")
            result = script.new()
        else:
            printerr("Failed to get script for class: " + name_of_class)
            return null
    
    if result == null:
        printerr("Failed to instantiate class: " + name_of_class)
    elif debug_mode:
        print("Successfully instantiated class: " + name_of_class + " of type: " + result.get_class())
    
    return result

# Create a new scene with a specified root node type
func create_scene(params):
    print("Creating scene: " + params.scene_path)
    
    # Get project paths and log them for debugging
    var project_res_path = "res://"
    var project_user_path = "user://"
    var global_res_path = ProjectSettings.globalize_path(project_res_path)
    var global_user_path = ProjectSettings.globalize_path(project_user_path)
    
    if debug_mode:
        print("Project paths:")
        print("- res:// path: " + project_res_path)
        print("- user:// path: " + project_user_path)
        print("- Globalized res:// path: " + global_res_path)
        print("- Globalized user:// path: " + global_user_path)
        
        # Print some common environment variables for debugging
        print("Environment variables:")
        var env_vars = ["PATH", "HOME", "USER", "TEMP", "GODOT_PATH"]
        for env_var in env_vars:
            if OS.has_environment(env_var):
                print("  " + env_var + " = " + OS.get_environment(env_var))
    
    # Normalize the scene path
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)
    
    # Convert resource path to an absolute path
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)
    
    # Get the scene directory paths
    var scene_dir_res = full_scene_path.get_base_dir()
    var scene_dir_abs = absolute_scene_path.get_base_dir()
    if debug_mode:
        print("Scene directory (resource path): " + scene_dir_res)
        print("Scene directory (absolute path): " + scene_dir_abs)
    
    # Only do extensive testing in debug mode
    if debug_mode:
        # Try to create a simple test file in the project root to verify write access
        var initial_test_file_path = "res://godot_mcp_test_write.tmp"
        var initial_test_file = FileAccess.open(initial_test_file_path, FileAccess.WRITE)
        if initial_test_file:
            initial_test_file.store_string("Test write access")
            initial_test_file.close()
            print("Successfully wrote test file to project root: " + initial_test_file_path)
            
            # Verify the test file exists
            var initial_test_file_exists = FileAccess.file_exists(initial_test_file_path)
            print("Test file exists check: " + str(initial_test_file_exists))
            
            # Clean up the test file
            if initial_test_file_exists:
                var remove_error = DirAccess.remove_absolute(ProjectSettings.globalize_path(initial_test_file_path))
                print("Test file removal result: " + str(remove_error))
        else:
            var write_error = FileAccess.get_open_error()
            printerr("Failed to write test file to project root: " + str(write_error))
            printerr("This indicates a serious permission issue with the project directory")
    
    # Use traditional if-else statement for better compatibility
    var root_node_type = "Node2D"  # Default value
    if params.has("root_node_type"):
        root_node_type = params.root_node_type
    if debug_mode:
        print("Root node type: " + root_node_type)
    
    # Create the root node
    var scene_root = instantiate_class(root_node_type)
    if not scene_root:
        printerr("Failed to instantiate node of type: " + root_node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        quit(1)
    
    scene_root.name = "root"
    if debug_mode:
        print("Root node created with name: " + scene_root.name)
    
    # Set the owner of the root node to itself (important for scene saving)
    scene_root.owner = scene_root
    
    # Pack the scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        # Only do extensive testing in debug mode
        if debug_mode:
            # First, let's verify we can write to the project directory
            print("Testing write access to project directory...")
            var test_write_path = "res://test_write_access.tmp"
            var test_write_abs = ProjectSettings.globalize_path(test_write_path)
            var test_file = FileAccess.open(test_write_path, FileAccess.WRITE)
            
            if test_file:
                test_file.store_string("Write test")
                test_file.close()
                print("Successfully wrote test file to project directory")
                
                # Clean up test file
                if FileAccess.file_exists(test_write_path):
                    var remove_error = DirAccess.remove_absolute(test_write_abs)
                    print("Test file removal result: " + str(remove_error))
            else:
                var write_error = FileAccess.get_open_error()
                printerr("Failed to write test file to project directory: " + str(write_error))
                printerr("This may indicate permission issues with the project directory")
                # Continue anyway, as the scene directory might still be writable
        
        # Ensure the scene directory exists using DirAccess
        if debug_mode:
            print("Ensuring scene directory exists...")
        
        # Get the scene directory relative to res://
        var scene_dir_relative = scene_dir_res.substr(6)  # Remove "res://" prefix
        if debug_mode:
            print("Scene directory (relative to res://): " + scene_dir_relative)
        
        # Create the directory if needed
        if not scene_dir_relative.is_empty():
            # First check if it exists
            var dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
            if debug_mode:
                print("Directory exists check (absolute): " + str(dir_exists))
            
            if not dir_exists:
                if debug_mode:
                    print("Directory doesn't exist, creating: " + scene_dir_relative)
                
                # Try to create the directory using DirAccess
                var dir = DirAccess.open("res://")
                if dir == null:
                    var open_error = DirAccess.get_open_error()
                    printerr("Failed to open res:// directory: " + str(open_error))
                    
                    # Try alternative approach with absolute path
                    if debug_mode:
                        print("Trying alternative directory creation approach...")
                    var make_dir_error = DirAccess.make_dir_recursive_absolute(scene_dir_abs)
                    if debug_mode:
                        print("Make directory result (absolute): " + str(make_dir_error))
                    
                    if make_dir_error != OK:
                        printerr("Failed to create directory using absolute path")
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)
                else:
                    # Create the directory using the DirAccess instance
                    if debug_mode:
                        print("Creating directory using DirAccess: " + scene_dir_relative)
                    var make_dir_error = dir.make_dir_recursive(scene_dir_relative)
                    if debug_mode:
                        print("Make directory result: " + str(make_dir_error))
                    
                    if make_dir_error != OK:
                        printerr("Failed to create directory: " + scene_dir_relative)
                        printerr("Error code: " + str(make_dir_error))
                        quit(1)
                
                # Verify the directory was created
                dir_exists = DirAccess.dir_exists_absolute(scene_dir_abs)
                if debug_mode:
                    print("Directory exists check after creation: " + str(dir_exists))
                
                if not dir_exists:
                    printerr("Directory reported as created but does not exist: " + scene_dir_abs)
                    printerr("This may indicate a problem with path resolution or permissions")
                    quit(1)
            elif debug_mode:
                print("Directory already exists: " + scene_dir_abs)
        
        # Save the scene
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var save_error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        
        if save_error == OK:
            # Only do extensive testing in debug mode
            if debug_mode:
                # Wait a moment to ensure file system has time to complete the write
                print("Waiting for file system to complete write operation...")
                OS.delay_msec(500)  # 500ms delay
                
                # Verify the file was actually created using multiple methods
                var file_check_abs = FileAccess.file_exists(absolute_scene_path)
                print("File exists check (absolute path): " + str(file_check_abs))
                
                var file_check_res = FileAccess.file_exists(full_scene_path)
                print("File exists check (resource path): " + str(file_check_res))
                
                var res_exists = ResourceLoader.exists(full_scene_path)
                print("Resource exists check: " + str(res_exists))
                
                # If file doesn't exist by absolute path, try to create a test file in the same directory
                if not file_check_abs and not file_check_res:
                    printerr("Scene file not found after save. Trying to diagnose the issue...")
                    
                    # Try to write a test file to the same directory
                    var test_scene_file_path = scene_dir_res + "/test_scene_file.tmp"
                    var test_scene_file = FileAccess.open(test_scene_file_path, FileAccess.WRITE)
                    
                    if test_scene_file:
                        test_scene_file.store_string("Test scene directory write")
                        test_scene_file.close()
                        print("Successfully wrote test file to scene directory: " + test_scene_file_path)
                        
                        # Check if the test file exists
                        var test_file_exists = FileAccess.file_exists(test_scene_file_path)
                        print("Test file exists: " + str(test_file_exists))
                        
                        if test_file_exists:
                            # Directory is writable, so the issue is with scene saving
                            printerr("Directory is writable but scene file wasn't created.")
                            printerr("This suggests an issue with ResourceSaver.save() or the packed scene.")
                            
                            # Try saving with a different approach
                            print("Trying alternative save approach...")
                            var alt_save_error = ResourceSaver.save(packed_scene, test_scene_file_path + ".tscn")
                            print("Alternative save result: " + str(alt_save_error))
                            
                            # Clean up test files
                            DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path))
                            if alt_save_error == OK:
                                DirAccess.remove_absolute(ProjectSettings.globalize_path(test_scene_file_path + ".tscn"))
                        else:
                            printerr("Test file couldn't be verified. This suggests filesystem access issues.")
                    else:
                        var write_error = FileAccess.get_open_error()
                        printerr("Failed to write test file to scene directory: " + str(write_error))
                        printerr("This confirms there are permission or path issues with the scene directory.")
                    
                    # Return error since we couldn't create the scene file
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)
                
                # If we get here, at least one of our file checks passed
                if file_check_abs or file_check_res or res_exists:
                    print("Scene file verified to exist!")
                    
                    # Try to load the scene to verify it's valid
                    var test_load = ResourceLoader.load(full_scene_path)
                    if test_load:
                        print("Scene created and verified successfully at: " + params.scene_path)
                        print("Scene file can be loaded correctly.")
                    else:
                        print("Scene file exists but cannot be loaded. It may be corrupted or incomplete.")
                        # Continue anyway since the file exists
                    
                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("All file existence checks failed despite successful save operation.")
                    printerr("This indicates a serious issue with file system access or path resolution.")
                    quit(1)
            else:
                # In non-debug mode, just check if the file exists
                var file_exists = FileAccess.file_exists(full_scene_path)
                if file_exists:
                    print("Scene created successfully at: " + params.scene_path)
                else:
                    printerr("Failed to create scene: " + params.scene_path)
                    quit(1)
        else:
            # Handle specific error codes
            var error_message = "Failed to save scene. Error code: " + str(save_error)
            
            if save_error == ERR_CANT_CREATE:
                error_message += " (ERR_CANT_CREATE - Cannot create the scene file)"
            elif save_error == ERR_CANT_OPEN:
                error_message += " (ERR_CANT_OPEN - Cannot open the scene file for writing)"
            elif save_error == ERR_FILE_CANT_WRITE:
                error_message += " (ERR_FILE_CANT_WRITE - Cannot write to the scene file)"
            elif save_error == ERR_FILE_NO_PERMISSION:
                error_message += " (ERR_FILE_NO_PERMISSION - No permission to write the scene file)"
            
            printerr(error_message)
            quit(1)
    else:
        printerr("Failed to pack scene: " + str(result))
        printerr("Error code: " + str(result))
        quit(1)

# Add a node to an existing scene
func add_node(params):
    print("Adding node to scene: " + params.scene_path)
    
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    if debug_mode:
        print("Scene path (with res://): " + full_scene_path)
    
    var absolute_scene_path = ProjectSettings.globalize_path(full_scene_path)
    if debug_mode:
        print("Absolute scene path: " + absolute_scene_path)
    
    if not FileAccess.file_exists(absolute_scene_path):
        printerr("Scene file does not exist at: " + absolute_scene_path)
        quit(1)
    
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Use traditional if-else statement for better compatibility
    var parent_path = "root"  # Default value
    if params.has("parent_node_path"):
        parent_path = params.parent_node_path
    if debug_mode:
        print("Parent path: " + parent_path)
    
    var parent = scene_root
    if parent_path != "root":
        parent = scene_root.get_node(parent_path.replace("root/", ""))
        if not parent:
            printerr("Parent node not found: " + parent_path)
            quit(1)
    if debug_mode:
        print("Parent node found: " + parent.name)
    
    if debug_mode:
        print("Instantiating node of type: " + params.node_type)
    var new_node = instantiate_class(params.node_type)
    if not new_node:
        printerr("Failed to instantiate node of type: " + params.node_type)
        printerr("Make sure the class exists and can be instantiated")
        printerr("Check if the class is registered in ClassDB or available as a script")
        quit(1)
    new_node.name = params.node_name
    if debug_mode:
        print("New node created with name: " + new_node.name)
    
    if params.has("properties"):
        if debug_mode:
            print("Setting properties on node")
        var properties = params.properties
        for property in properties:
            if debug_mode:
                print("Setting property: " + property + " = " + str(properties[property]))
            new_node.set(property, properties[property])
    
    parent.add_child(new_node)
    new_node.owner = scene_root
    if debug_mode:
        print("Node added to parent and ownership set")
    
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + absolute_scene_path)
        var save_error = ResourceSaver.save(packed_scene, absolute_scene_path)
        if debug_mode:
            print("Save result: " + str(save_error) + " (OK=" + str(OK) + ")")
        if save_error == OK:
            if debug_mode:
                var file_check_after = FileAccess.file_exists(absolute_scene_path)
                print("File exists check after save: " + str(file_check_after))
                if file_check_after:
                    print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
                else:
                    printerr("File reported as saved but does not exist at: " + absolute_scene_path)
            else:
                print("Node '" + params.node_name + "' of type '" + params.node_type + "' added successfully")
        else:
            printerr("Failed to save scene: " + str(save_error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Load a sprite into a Sprite2D node
func load_sprite(params):
    print("Loading sprite into scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Ensure the texture path starts with res:// for Godot's resource system
    var full_texture_path = params.texture_path
    if not full_texture_path.begins_with("res://"):
        full_texture_path = "res://" + full_texture_path
    
    if debug_mode:
        print("Full texture path (with res://): " + full_texture_path)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the sprite node
    var node_path = params.node_path
    if debug_mode:
        print("Original node path: " + node_path)
    
    if node_path.begins_with("root/"):
        node_path = node_path.substr(5)  # Remove "root/" prefix
        if debug_mode:
            print("Node path after removing 'root/' prefix: " + node_path)
    
    var sprite_node = null
    if node_path == "":
        # If no node path, assume root is the sprite
        sprite_node = scene_root
        if debug_mode:
            print("Using root node as sprite node")
    else:
        sprite_node = scene_root.get_node(node_path)
        if sprite_node and debug_mode:
            print("Found sprite node: " + sprite_node.name)
    
    if not sprite_node:
        printerr("Node not found: " + params.node_path)
        quit(1)
    
    # Check if the node is a Sprite2D or compatible type
    if debug_mode:
        print("Node class: " + sprite_node.get_class())
    if not (sprite_node is Sprite2D or sprite_node is Sprite3D or sprite_node is TextureRect):
        printerr("Node is not a sprite-compatible type: " + sprite_node.get_class())
        quit(1)
    
    # Load the texture
    if debug_mode:
        print("Loading texture from: " + full_texture_path)
    var texture = load(full_texture_path)
    if not texture:
        printerr("Failed to load texture: " + full_texture_path)
        quit(1)
    
    if debug_mode:
        print("Texture loaded successfully")
    
    # Set the texture on the sprite
    if sprite_node is Sprite2D or sprite_node is Sprite3D:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on Sprite2D/Sprite3D node")
    elif sprite_node is TextureRect:
        sprite_node.texture = texture
        if debug_mode:
            print("Set texture on TextureRect node")
    
    # Save the modified scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + full_scene_path)
        var error = ResourceSaver.save(packed_scene, full_scene_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually updated
            if debug_mode:
                var file_check_after = FileAccess.file_exists(full_scene_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("Sprite loaded successfully with texture: " + full_texture_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(full_scene_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + full_scene_path)
            else:
                print("Sprite loaded successfully with texture: " + full_texture_path)
        else:
            printerr("Failed to save scene: " + str(error))
    else:
        printerr("Failed to pack scene: " + str(result))

# Export a scene as a MeshLibrary resource
func export_mesh_library(params):
    print("Exporting MeshLibrary from scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Ensure the output path starts with res:// for Godot's resource system
    var full_output_path = params.output_path
    if not full_output_path.begins_with("res://"):
        full_output_path = "res://" + full_output_path
    
    if debug_mode:
        print("Full output path (with res://): " + full_output_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Load the scene
    if debug_mode:
        print("Loading scene from: " + full_scene_path)
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Create a new MeshLibrary
    var mesh_library = MeshLibrary.new()
    if debug_mode:
        print("Created new MeshLibrary")
    
    # Get mesh item names if provided
    var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
    var use_specific_items = mesh_item_names.size() > 0
    
    if debug_mode:
        if use_specific_items:
            print("Using specific mesh items: " + str(mesh_item_names))
        else:
            print("Using all mesh items in the scene")
    
    # Process all child nodes
    var item_id = 0
    if debug_mode:
        print("Processing child nodes...")
    
    for child in scene_root.get_children():
        if debug_mode:
            print("Checking child node: " + child.name)
        
        # Skip if not using all items and this item is not in the list
        if use_specific_items and not (child.name in mesh_item_names):
            if debug_mode:
                print("Skipping node " + child.name + " (not in specified items list)")
            continue
            
        # Check if the child has a mesh
        var mesh_instance = null
        if child is MeshInstance3D:
            mesh_instance = child
            if debug_mode:
                print("Node " + child.name + " is a MeshInstance3D")
        else:
            # Try to find a MeshInstance3D in the child's descendants
            if debug_mode:
                print("Searching for MeshInstance3D in descendants of " + child.name)
            for descendant in child.get_children():
                if descendant is MeshInstance3D:
                    mesh_instance = descendant
                    if debug_mode:
                        print("Found MeshInstance3D in descendant: " + descendant.name)
                    break
        
        if mesh_instance and mesh_instance.mesh:
            if debug_mode:
                print("Adding mesh: " + child.name)
            
            # Add the mesh to the library
            mesh_library.create_item(item_id)
            mesh_library.set_item_name(item_id, child.name)
            mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
            if debug_mode:
                print("Added mesh to library with ID: " + str(item_id))
            
            # Add collision shape if available
            var collision_added = false
            for collision_child in child.get_children():
                if collision_child is CollisionShape3D and collision_child.shape:
                    mesh_library.set_item_shapes(item_id, [collision_child.shape])
                    if debug_mode:
                        print("Added collision shape from: " + collision_child.name)
                    collision_added = true
                    break
            
            if debug_mode and not collision_added:
                print("No collision shape found for mesh: " + child.name)
            
            # Add preview if available
            if mesh_instance.mesh:
                mesh_library.set_item_preview(item_id, mesh_instance.mesh)
                if debug_mode:
                    print("Added preview for mesh: " + child.name)
            
            item_id += 1
        elif debug_mode:
            print("Node " + child.name + " has no valid mesh")
    
    if debug_mode:
        print("Processed " + str(item_id) + " meshes")
    
    # Create directory if it doesn't exist
    var dir = DirAccess.open("res://")
    if dir == null:
        printerr("Failed to open res:// directory")
        printerr("DirAccess error: " + str(DirAccess.get_open_error()))
        quit(1)
        
    var output_dir = full_output_path.get_base_dir()
    if debug_mode:
        print("Output directory: " + output_dir)
    
    if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):  # Remove "res://" prefix
        if debug_mode:
            print("Creating directory: " + output_dir)
        var error = dir.make_dir_recursive(output_dir.substr(6))  # Remove "res://" prefix
        if error != OK:
            printerr("Failed to create directory: " + output_dir + ", error: " + str(error))
            quit(1)
    
    # Save the mesh library
    if item_id > 0:
        if debug_mode:
            print("Saving MeshLibrary to: " + full_output_path)
        var error = ResourceSaver.save(mesh_library, full_output_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually created
            if debug_mode:
                var file_check_after = FileAccess.file_exists(full_output_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(full_output_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + full_output_path)
            else:
                print("MeshLibrary exported successfully with " + str(item_id) + " items to: " + full_output_path)
        else:
            printerr("Failed to save MeshLibrary: " + str(error))
    else:
        printerr("No valid meshes found in the scene")

# Find files with a specific extension recursively
func find_files(path, extension):
    var files = []
    var dir = DirAccess.open(path)
    
    if dir:
        dir.list_dir_begin()
        var file_name = dir.get_next()
        
        while file_name != "":
            if dir.current_is_dir() and not file_name.begins_with("."):
                files.append_array(find_files(path + file_name + "/", extension))
            elif file_name.ends_with(extension):
                files.append(path + file_name)
            
            file_name = dir.get_next()
    
    return files

# Get UID for a specific file
func get_uid(params):
    if not params.has("file_path"):
        printerr("File path is required")
        quit(1)
    
    # Ensure the file path starts with res:// for Godot's resource system
    var file_path = params.file_path
    if not file_path.begins_with("res://"):
        file_path = "res://" + file_path
    
    print("Getting UID for file: " + file_path)
    if debug_mode:
        print("Full file path (with res://): " + file_path)
    
    # Get the absolute path for reference
    var absolute_path = ProjectSettings.globalize_path(file_path)
    if debug_mode:
        print("Absolute file path: " + absolute_path)
    
    # Ensure the file exists
    var file_check = FileAccess.file_exists(file_path)
    if debug_mode:
        print("File exists check: " + str(file_check))
    
    if not file_check:
        printerr("File does not exist at: " + file_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Check if the UID file exists
    var uid_path = file_path + ".uid"
    if debug_mode:
        print("UID file path: " + uid_path)
    
    var uid_check = FileAccess.file_exists(uid_path)
    if debug_mode:
        print("UID file exists check: " + str(uid_check))
    
    var f = FileAccess.open(uid_path, FileAccess.READ)
    
    if f:
        # Read the UID content
        var uid_content = f.get_as_text()
        f.close()
        if debug_mode:
            print("UID content read successfully")
        
        # Return the UID content
        var result = {
            "file": file_path,
            "absolutePath": absolute_path,
            "uid": uid_content.strip_edges(),
            "exists": true
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))
    else:
        if debug_mode:
            print("UID file does not exist or could not be opened")
        
        # UID file doesn't exist
        var result = {
            "file": file_path,
            "absolutePath": absolute_path,
            "exists": false,
            "message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
        }
        if debug_mode:
            print("UID result: " + JSON.stringify(result))
        print(JSON.stringify(result))

# Resave all resources to update UID references
func resave_resources(params):
    print("Resaving all resources to update UID references...")
    
    # Get project path if provided
    var project_path = "res://"
    if params.has("project_path"):
        project_path = params.project_path
        if not project_path.begins_with("res://"):
            project_path = "res://" + project_path
        if not project_path.ends_with("/"):
            project_path += "/"
    
    if debug_mode:
        print("Using project path: " + project_path)
    
    # Get all .tscn files
    if debug_mode:
        print("Searching for scene files in: " + project_path)
    var scenes = find_files(project_path, ".tscn")
    if debug_mode:
        print("Found " + str(scenes.size()) + " scenes")
    
    # Resave each scene
    var success_count = 0
    var error_count = 0
    
    for scene_path in scenes:
        if debug_mode:
            print("Processing scene: " + scene_path)
        
        # Check if the scene file exists
        var file_check = FileAccess.file_exists(scene_path)
        if debug_mode:
            print("Scene file exists check: " + str(file_check))
        
        if not file_check:
            printerr("Scene file does not exist at: " + scene_path)
            error_count += 1
            continue
        
        # Load the scene
        var scene = load(scene_path)
        if scene:
            if debug_mode:
                print("Scene loaded successfully, saving...")
            var error = ResourceSaver.save(scene, scene_path)
            if debug_mode:
                print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
            
            if error == OK:
                success_count += 1
                if debug_mode:
                    print("Scene saved successfully: " + scene_path)
                
                    # Verify the file was actually updated
                    var file_check_after = FileAccess.file_exists(scene_path)
                    print("File exists check after save: " + str(file_check_after))
                
                    if not file_check_after:
                        printerr("File reported as saved but does not exist at: " + scene_path)
            else:
                error_count += 1
                printerr("Failed to save: " + scene_path + ", error: " + str(error))
        else:
            error_count += 1
            printerr("Failed to load: " + scene_path)
    
    # Get all .gd and .shader files
    if debug_mode:
        print("Searching for script and shader files in: " + project_path)
    var scripts = find_files(project_path, ".gd") + find_files(project_path, ".shader") + find_files(project_path, ".gdshader")
    if debug_mode:
        print("Found " + str(scripts.size()) + " scripts/shaders")
    
    # Check for missing .uid files
    var missing_uids = 0
    var generated_uids = 0
    
    for script_path in scripts:
        if debug_mode:
            print("Checking UID for: " + script_path)
        var uid_path = script_path + ".uid"
        
        var uid_check = FileAccess.file_exists(uid_path)
        if debug_mode:
            print("UID file exists check: " + str(uid_check))
        
        var f = FileAccess.open(uid_path, FileAccess.READ)
        if not f:
            missing_uids += 1
            if debug_mode:
                print("Missing UID file for: " + script_path + ", generating...")
            
            # Force a save to generate UID
            var res = load(script_path)
            if res:
                var error = ResourceSaver.save(res, script_path)
                if debug_mode:
                    print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
                
                if error == OK:
                    generated_uids += 1
                    if debug_mode:
                        print("Generated UID for: " + script_path)
                    
                        # Verify the UID file was actually created
                        var uid_check_after = FileAccess.file_exists(uid_path)
                        print("UID file exists check after save: " + str(uid_check_after))
                    
                        if not uid_check_after:
                            printerr("UID file reported as generated but does not exist at: " + uid_path)
                else:
                    printerr("Failed to generate UID for: " + script_path + ", error: " + str(error))
            else:
                printerr("Failed to load resource: " + script_path)
        elif debug_mode:
            print("UID file already exists for: " + script_path)
    
    if debug_mode:
        print("Summary:")
        print("- Scenes processed: " + str(scenes.size()))
        print("- Scenes successfully saved: " + str(success_count))
        print("- Scenes with errors: " + str(error_count))
        print("- Scripts/shaders missing UIDs: " + str(missing_uids))
        print("- UIDs successfully generated: " + str(generated_uids))
    print("Resave operation complete")

# Save changes to a scene file
func save_scene(params):
    print("Saving scene: " + params.scene_path)
    
    # Ensure the scene path starts with res:// for Godot's resource system
    var full_scene_path = params.scene_path
    if not full_scene_path.begins_with("res://"):
        full_scene_path = "res://" + full_scene_path
    
    if debug_mode:
        print("Full scene path (with res://): " + full_scene_path)
    
    # Check if the scene file exists
    var file_check = FileAccess.file_exists(full_scene_path)
    if debug_mode:
        print("Scene file exists check: " + str(file_check))
    
    if not file_check:
        printerr("Scene file does not exist at: " + full_scene_path)
        # Get the absolute path for reference
        var absolute_path = ProjectSettings.globalize_path(full_scene_path)
        printerr("Absolute file path that doesn't exist: " + absolute_path)
        quit(1)
    
    # Load the scene
    var scene = load(full_scene_path)
    if not scene:
        printerr("Failed to load scene: " + full_scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Determine save path
    var save_path = params.new_path if params.has("new_path") else full_scene_path
    if params.has("new_path") and not save_path.begins_with("res://"):
        save_path = "res://" + save_path
    
    if debug_mode:
        print("Save path: " + save_path)
    
    # Create directory if it doesn't exist
    if params.has("new_path"):
        var dir = DirAccess.open("res://")
        if dir == null:
            printerr("Failed to open res:// directory")
            printerr("DirAccess error: " + str(DirAccess.get_open_error()))
            quit(1)
            
        var scene_dir = save_path.get_base_dir()
        if debug_mode:
            print("Scene directory: " + scene_dir)
        
        if scene_dir != "res://" and not dir.dir_exists(scene_dir.substr(6)):  # Remove "res://" prefix
            if debug_mode:
                print("Creating directory: " + scene_dir)
            var error = dir.make_dir_recursive(scene_dir.substr(6))  # Remove "res://" prefix
            if error != OK:
                printerr("Failed to create directory: " + scene_dir + ", error: " + str(error))
                quit(1)
    
    # Create a packed scene
    var packed_scene = PackedScene.new()
    var result = packed_scene.pack(scene_root)
    if debug_mode:
        print("Pack result: " + str(result) + " (OK=" + str(OK) + ")")
    
    if result == OK:
        if debug_mode:
            print("Saving scene to: " + save_path)
        var error = ResourceSaver.save(packed_scene, save_path)
        if debug_mode:
            print("Save result: " + str(error) + " (OK=" + str(OK) + ")")
        
        if error == OK:
            # Verify the file was actually created/updated
            if debug_mode:
                var file_check_after = FileAccess.file_exists(save_path)
                print("File exists check after save: " + str(file_check_after))
                
                if file_check_after:
                    print("Scene saved successfully to: " + save_path)
                    # Get the absolute path for reference
                    var absolute_path = ProjectSettings.globalize_path(save_path)
                    print("Absolute file path: " + absolute_path)
                else:
                    printerr("File reported as saved but does not exist at: " + save_path)
            else:
                print("Scene saved successfully to: " + save_path)
        else:
            printerr("Failed to save scene: " + str(error))
    else:
        printerr("Failed to pack scene: " + str(result))


# Capture a screenshot of a scene
func capture_screenshot(params):
    print("Capturing screenshot...")
    
    # Get parameters
    var scene_path = params.scene_path
    var output_path = params.output_path
    var width = params.get("width", 1920)
    var height = params.get("height", 1080)
    var delay = params.get("delay", 0.5)  # 延迟秒数，等待场景稳定
    
    # Ensure paths start with res://
    if not scene_path.begins_with("res://"):
        scene_path = "res://" + scene_path
    if not output_path.begins_with("res://"):
        output_path = "res://" + output_path
    
    if debug_mode:
        print("Scene path: " + scene_path)
        print("Output path: " + output_path)
        print("Resolution: " + str(width) + "x" + str(height))
        print("Delay: " + str(delay) + "s")
    
    # Check if scene file exists
    if not FileAccess.file_exists(scene_path):
        printerr("Scene file does not exist at: " + scene_path)
        quit(1)
    
    # Load the scene
    var scene = load(scene_path)
    if not scene:
        printerr("Failed to load scene: " + scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene
    var instance = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Create a SubViewport for rendering
    var viewport = SubViewport.new()
    viewport.size = Vector2(width, height)
    viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
    viewport.transparent_bg = params.get("transparent_bg", false)
    
    # Enable 2D and 3D rendering as needed
    viewport.disable_3d = params.get("disable_3d", false)
    viewport.own_world_3d = true
    
    # Add instance to viewport
    viewport.add_child(instance)
    
    # Add viewport to tree temporarily
    root.add_child(viewport)
    
    if debug_mode:
        print("Viewport created and scene added")
    
    # Wait for specified delay (convert to milliseconds)
    var delay_ms = int(delay * 1000)
    if debug_mode:
        print("Waiting " + str(delay_ms) + "ms for scene to stabilize...")
    
    OS.delay_msec(delay_ms)
    
    # Force render
    viewport.render_target_update_mode = SubViewport.UPDATE_ONCE
    
    # Wait a frame for rendering to complete
    await root.get_tree().process_frame
    
    if debug_mode:
        print("Rendering complete, capturing image...")
    
    # Get the image from viewport texture
    var image = viewport.get_texture().get_image()
    if not image:
        printerr("Failed to capture image from viewport")
        viewport.queue_free()
        quit(1)
    
    if debug_mode:
        print("Image captured, size: " + str(image.get_size()))
    
    # Ensure output directory exists
    var output_dir = output_path.get_base_dir()
    if output_dir != "res://":
        var dir = DirAccess.open("res://")
        if dir:
            var rel_dir = output_dir.substr(6)  # Remove "res://"
            if not dir.dir_exists(rel_dir):
                if debug_mode:
                    print("Creating output directory: " + rel_dir)
                var err = dir.make_dir_recursive(rel_dir)
                if err != OK:
                    printerr("Failed to create directory: " + rel_dir)
        else:
            printerr("Failed to open res:// directory")
    
    # Save the image
    var global_output_path = ProjectSettings.globalize_path(output_path)
    var err = image.save_png(global_output_path)
    
    if err == OK:
        if debug_mode:
            print("Screenshot saved to: " + output_path)
            print("Absolute path: " + global_output_path)
        
        # Verify file was created
        if FileAccess.file_exists(output_path):
            var result = {
                "success": true,
                "path": output_path,
                "absolute_path": global_output_path,
                "size": image.get_size()
            }
            print(JSON.stringify(result))
        else:
            printerr("File was not created at: " + output_path)
    else:
        printerr("Failed to save screenshot. Error code: " + str(err))
    
    # Cleanup
    viewport.queue_free()
    
    if debug_mode:
        print("Screenshot capture complete")


# Attach a script to a node in a scene
func attach_script(params):
    print("Attaching script to node...")
    
    # Get parameters
    var scene_path = params.scene_path
    var node_path = params.node_path
    var script_path = params.script_path
    
    # Ensure paths start with res://
    if not scene_path.begins_with("res://"):
        scene_path = "res://" + scene_path
    if not script_path.begins_with("res://"):
        script_path = "res://" + script_path
    
    if debug_mode:
        print("Scene path: " + scene_path)
        print("Node path: " + node_path)
        print("Script path: " + script_path)
    
    # Check if scene file exists
    if not FileAccess.file_exists(scene_path):
        printerr("Scene file does not exist at: " + scene_path)
        quit(1)
    
    # Check if script file exists
    if not FileAccess.file_exists(script_path):
        printerr("Script file does not exist at: " + script_path)
        printerr("Please create the script file first before attaching")
        quit(1)
    
    # Load the scene
    var scene = load(scene_path)
    if not scene:
        printerr("Failed to load scene: " + scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene to edit
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the target node
    var target_node = null
    
    if node_path == "root" or node_path == ".":
        target_node = scene_root
        if debug_mode:
            print("Using root node as target")
    else:
        # Remove "root/" prefix if present
        var search_path = node_path
        if search_path.begins_with("root/"):
            search_path = search_path.substr(5)  # Remove "root/"
        elif search_path.begins_with("root"):
            search_path = search_path.substr(4)  # Remove "root"
        
        if debug_mode:
            print("Searching for node at path: " + search_path)
        
        if search_path.is_empty():
            target_node = scene_root
        else:
            target_node = scene_root.get_node(search_path)
    
    if not target_node:
        printerr("Node not found: " + node_path)
        printerr("Available children of root: " + str(scene_root.get_children()))
        quit(1)
    
    if debug_mode:
        print("Found target node: " + target_node.name + " (type: " + target_node.get_class() + ")")
    
    # Load the script
    var script = load(script_path)
    if not script:
        printerr("Failed to load script: " + script_path)
        quit(1)
    
    if not (script is GDScript or script is CSharpScript):
        printerr("File is not a valid script: " + script_path)
        quit(1)
    
    if debug_mode:
        print("Script loaded successfully: " + script_path)
    
    # Check if node already has a script
    var existing_script = target_node.get_script()
    if existing_script:
        if debug_mode:
            print("Node already has a script, will be replaced")
    
    # Attach the script
    target_node.set_script(script)
    
    if debug_mode:
        print("Script attached to node")
    
    # Verify attachment
    var attached_script = target_node.get_script()
    if attached_script == script:
        if debug_mode:
            print("Script attachment verified")
    else:
        printerr("Script attachment failed - script not found on node after setting")
        quit(1)
    
    # Pack and save the scene
    var packed_scene = PackedScene.new()
    var pack_result = packed_scene.pack(scene_root)
    
    if pack_result != OK:
        printerr("Failed to pack scene: " + str(pack_result))
        quit(1)
    
    if debug_mode:
        print("Scene packed successfully")
    
    # Save the scene
    var save_result = ResourceSaver.save(packed_scene, scene_path)
    
    if save_result != OK:
        printerr("Failed to save scene: " + str(save_result))
        quit(1)
    
    if debug_mode:
        print("Scene saved successfully")
        
        # Verify file exists
        var file_check = FileAccess.file_exists(scene_path)
        print("File exists check: " + str(file_check))
    
    # Return success result
    var result = {
        "success": true,
        "scene_path": scene_path,
        "node_path": node_path,
        "script_path": script_path,
        "node_type": target_node.get_class()
    }
    print(JSON.stringify(result))
    
    # Cleanup
    scene_root.free()
    
    if debug_mode:
        print("Script attached successfully to " + node_path)


# Connect a signal to a method in a scene
func connect_signal(params):
    print("Connecting signal...")
    
    # Get parameters
    var scene_path = params.scene_path
    var node_path = params.node_path
    var signal_name = params.signal_name
    var target_path = params.target_path
    var method_name = params.method_name
    var flags = params.get("flags", 0)
    
    # Ensure paths start with res://
    if not scene_path.begins_with("res://"):
        scene_path = "res://" + scene_path
    
    if debug_mode:
        print("Scene path: " + scene_path)
        print("Node path: " + node_path)
        print("Signal name: " + signal_name)
        print("Target path: " + target_path)
        print("Method name: " + method_name)
    
    # Check if scene file exists
    if not FileAccess.file_exists(scene_path):
        printerr("Scene file does not exist at: " + scene_path)
        quit(1)
    
    # Load the scene
    var scene = load(scene_path)
    if not scene:
        printerr("Failed to load scene: " + scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene to edit
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the source node (the one with the signal)
    var source_node = null
    if node_path == "root" or node_path == ".":
        source_node = scene_root
    else:
        var search_path = node_path
        if search_path.begins_with("root/"):
            search_path = search_path.substr(5)
        elif search_path.begins_with("root"):
            search_path = search_path.substr(4)
        
        if not search_path.is_empty():
            source_node = scene_root.get_node(search_path)
        else:
            source_node = scene_root
    
    if not source_node:
        printerr("Source node not found: " + node_path)
        quit(1)
    
    if debug_mode:
        print("Found source node: " + source_node.name)
    
    # Check if signal exists
    var has_signal = false
    var signal_list = source_node.get_signal_list()
    for sig in signal_list:
        if sig["name"] == signal_name:
            has_signal = true
            break
    
    if not has_signal:
        printerr("Signal '" + signal_name + "' not found on node: " + node_path)
        printerr("Available signals: " + str(signal_list.map(func(s): return s["name"])))
        quit(1)
    
    if debug_mode:
        print("Signal verified: " + signal_name)
    
    # Find the target node (the one with the method)
    var target_node = null
    if target_path == "root" or target_path == "." or target_path == node_path:
        target_node = source_node
    else:
        var target_search_path = target_path
        if target_search_path.begins_with("root/"):
            target_search_path = target_search_path.substr(5)
        elif target_search_path.begins_with("root"):
            target_search_path = target_search_path.substr(4)
        
        if not target_search_path.is_empty():
            target_node = scene_root.get_node(target_search_path)
        else:
            target_node = scene_root
    
    if not target_node:
        printerr("Target node not found: " + target_path)
        quit(1)
    
    if debug_mode:
        print("Found target node: " + target_node.name)
    
    # Check if method exists on target
    var has_method = target_node.has_method(method_name)
    if not has_method:
        # If target has a script, the method might be in the script
        # We can't fully validate this without the script being compiled
        # but we'll allow it and let Godot handle the error at runtime
        if debug_mode:
            print("Warning: Method '" + method_name + "' not found on target node, but it may be defined in the attached script")
    else:
        if debug_mode:
            print("Method verified: " + method_name)
    
    # Create the callable
    var callable = Callable(target_node, method_name)
    
    # Connect the signal
    var connect_result = OK
    if source_node.is_connected(signal_name, callable):
        if debug_mode:
            print("Signal already connected, disconnecting first...")
        source_node.disconnect(signal_name, callable)
    
    connect_result = source_node.connect(signal_name, callable, flags)
    
    if connect_result != OK:
        printerr("Failed to connect signal. Error code: " + str(connect_result))
        if connect_result == ERR_INVALID_PARAMETER:
            printerr("Invalid parameter - check signal and method signatures match")
        elif connect_result == ERR_ALREADY_EXISTS:
            printerr("Connection already exists")
        quit(1)
    
    if debug_mode:
        print("Signal connected successfully")
    
    # Pack and save the scene
    var packed_scene = PackedScene.new()
    var pack_result = packed_scene.pack(scene_root)
    
    if pack_result != OK:
        printerr("Failed to pack scene: " + str(pack_result))
        quit(1)
    
    if debug_mode:
        print("Scene packed successfully")
    
    # Save the scene
    var save_result = ResourceSaver.save(packed_scene, scene_path)
    
    if save_result != OK:
        printerr("Failed to save scene: " + str(save_result))
        quit(1)
    
    if debug_mode:
        print("Scene saved successfully")
    
    # Return success result
    var result = {
        "success": true,
        "scene_path": scene_path,
        "source_node": node_path,
        "signal_name": signal_name,
        "target_node": target_path,
        "method_name": method_name
    }
    print(JSON.stringify(result))
    
    # Cleanup
    scene_root.free()
    
    if debug_mode:
        print("Signal connection complete: " + signal_name + " -> " + method_name)


# Set a property on a node in a scene
func set_node_property(params):
    print("Setting node property...")
    
    # Get parameters
    var scene_path = params.scene_path
    var node_path = params.node_path
    var property_path = params.property_path
    var property_value = params.property_value
    
    # Ensure paths start with res://
    if not scene_path.begins_with("res://"):
        scene_path = "res://" + scene_path
    
    if debug_mode:
        print("Scene path: " + scene_path)
        print("Node path: " + node_path)
        print("Property path: " + property_path)
        print("Property value: " + str(property_value))
    
    # Check if scene file exists
    if not FileAccess.file_exists(scene_path):
        printerr("Scene file does not exist at: " + scene_path)
        quit(1)
    
    # Load the scene
    var scene = load(scene_path)
    if not scene:
        printerr("Failed to load scene: " + scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene to edit
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the target node
    var target_node = null
    if node_path == "root" or node_path == ".":
        target_node = scene_root
    else:
        var search_path = node_path
        if search_path.begins_with("root/"):
            search_path = search_path.substr(5)
        elif search_path.begins_with("root"):
            search_path = search_path.substr(4)
        
        if not search_path.is_empty():
            target_node = scene_root.get_node(search_path)
        else:
            target_node = scene_root
    
    if not target_node:
        printerr("Node not found: " + node_path)
        quit(1)
    
    if debug_mode:
        print("Found target node: " + target_node.name + " (type: " + target_node.get_class() + ")")
    
    # Parse and set the property value
    var parsed_value = parse_property_value(property_value)
    
    if debug_mode:
        print("Parsed value: " + str(parsed_value) + " (type: " + typeof(parsed_value) + ")")
    
    # Handle nested property paths (e.g., "position:x" or "theme_override_colors/font_color")
    var property_parts = property_path.split(":")
    if property_parts.size() == 2:
        # Handle "position:x" style notation
        var main_prop = property_parts[0]
        var sub_prop = property_parts[1]
        
        var current_value = target_node.get(main_prop)
        if current_value == null:
            printerr("Property '" + main_prop + "' not found on node")
            quit(1)
        
        # Set the sub-property
        if current_value is Vector2:
            if sub_prop == "x":
                target_node.set(main_prop, Vector2(parsed_value, current_value.y))
            elif sub_prop == "y":
                target_node.set(main_prop, Vector2(current_value.x, parsed_value))
            else:
                printerr("Invalid sub-property for Vector2: " + sub_prop)
                quit(1)
        elif current_value is Vector3:
            if sub_prop == "x":
                target_node.set(main_prop, Vector3(parsed_value, current_value.y, current_value.z))
            elif sub_prop == "y":
                target_node.set(main_prop, Vector3(current_value.x, parsed_value, current_value.z))
            elif sub_prop == "z":
                target_node.set(main_prop, Vector3(current_value.x, current_value.y, parsed_value))
            else:
                printerr("Invalid sub-property for Vector3: " + sub_prop)
                quit(1)
        elif current_value is Color:
            if sub_prop == "r":
                target_node.set(main_prop, Color(parsed_value, current_value.g, current_value.b, current_value.a))
            elif sub_prop == "g":
                target_node.set(main_prop, Color(current_value.r, parsed_value, current_value.b, current_value.a))
            elif sub_prop == "b":
                target_node.set(main_prop, Color(current_value.r, current_value.g, parsed_value, current_value.a))
            elif sub_prop == "a":
                target_node.set(main_prop, Color(current_value.r, current_value.g, current_value.b, parsed_value))
            elif sub_prop == "h":
                var hsv = current_value.to_hsv()
                target_node.set(main_prop, Color.from_hsv(parsed_value, hsv.y, hsv.z, current_value.a))
            elif sub_prop == "s":
                var hsv = current_value.to_hsv()
                target_node.set(main_prop, Color.from_hsv(hsv.x, parsed_value, hsv.z, current_value.a))
            elif sub_prop == "v":
                var hsv = current_value.to_hsv()
                target_node.set(main_prop, Color.from_hsv(hsv.x, hsv.y, parsed_value, current_value.a))
            else:
                printerr("Invalid sub-property for Color: " + sub_prop)
                quit(1)
        elif current_value is Rect2:
            if sub_prop == "x":
                target_node.set(main_prop, Rect2(Vector2(parsed_value, current_value.position.y), current_value.size))
            elif sub_prop == "y":
                target_node.set(main_prop, Rect2(Vector2(current_value.position.x, parsed_value), current_value.size))
            elif sub_prop == "width" or sub_prop == "w":
                target_node.set(main_prop, Rect2(current_value.position, Vector2(parsed_value, current_value.size.y)))
            elif sub_prop == "height" or sub_prop == "h":
                target_node.set(main_prop, Rect2(current_value.position, Vector2(current_value.size.x, parsed_value)))
            else:
                printerr("Invalid sub-property for Rect2: " + sub_prop)
                quit(1)
        else:
            printerr("Cannot set sub-property on type: " + str(typeof(current_value)))
            quit(1)
    else:
        # Handle theme override properties (which use "/" separator)
        if property_path.begins_with("theme_override_"):
            target_node.set_indexed(property_path, parsed_value)
        else:
            # Set the property directly
            target_node.set(property_path, parsed_value)
    
    if debug_mode:
        print("Property set successfully")
    
    # Pack and save the scene
    var packed_scene = PackedScene.new()
    var pack_result = packed_scene.pack(scene_root)
    
    if pack_result != OK:
        printerr("Failed to pack scene: " + str(pack_result))
        quit(1)
    
    if debug_mode:
        print("Scene packed successfully")
    
    # Save the scene
    var save_result = ResourceSaver.save(packed_scene, scene_path)
    
    if save_result != OK:
        printerr("Failed to save scene: " + str(save_result))
        quit(1)
    
    if debug_mode:
        print("Scene saved successfully")
    
    # Return success result
    var result = {
        "success": true,
        "scene_path": scene_path,
        "node_path": node_path,
        "property_path": property_path,
        "property_value": str(parsed_value)
    }
    print(JSON.stringify(result))
    
    # Cleanup
    scene_root.free()
    
    if debug_mode:
        print("Property set complete: " + property_path + " = " + str(parsed_value))

# Parse a property value from string or JSON to Godot type
func parse_property_value(value):
    # Handle different types of input
    
    # If it's already a number, bool, or null, return as-is
    if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT:
        return value
    if typeof(value) == TYPE_BOOL:
        return value
    if typeof(value) == TYPE_NIL:
        return null
    
    # If it's not a string, convert to string first
    var str_value = str(value)
    
    # Try to parse Vector2 (e.g., "Vector2(100, 200)" or "(100, 200)")
    var vector2_match = str_value.match(r"^\\s*(?:Vector2)?\\s*\\(\\s*([+-]?\\d+\\.?\\d*)\\s*,\\s*([+-]?\\d+\\.?\\d*)\\s*\\)\\s*$")
    if vector2_match:
        return Vector2(float(vector2_match[1]), float(vector2_match[2]))
    
    # Try to parse Vector3
    var vector3_match = str_value.match(r"^\\s*(?:Vector3)?\\s*\\(\\s*([+-]?\\d+\\.?\\d*)\\s*,\\s*([+-]?\\d+\\.?\\d*)\\s*,\\s*([+-]?\\d+\\.?\\d*)\\s*\\)\\s*$")
    if vector3_match:
        return Vector3(float(vector3_match[1]), float(vector3_match[2]), float(vector3_match[3]))
    
    # Try to parse Color (e.g., "Color.red", "Color(1, 0, 0)", "#ff0000")
    if str_value.begins_with("Color."):
        var color_name = str_value.substr(6)
        match color_name:
            "white": return Color.WHITE
            "black": return Color.BLACK
            "red": return Color.RED
            "green": return Color.GREEN
            "blue": return Color.BLUE
            "yellow": return Color.YELLOW
            "cyan": return Color.CYAN
            "magenta": return Color.MAGENTA
            "orange": return Color.ORANGE
            "gray": return Color.GRAY
            "transparent": return Color.TRANSPARENT
            _:
                printerr("Unknown color name: " + color_name)
    
    var color_match = str_value.match(r"^\\s*Color\\s*\\(\\s*([+-]?\\d+\\.?\\d*)\\s*,\\s*([+-]?\\d+\\.?\\d*)\\s*,\\s*([+-]?\\d+\\.?\\d*)\\s*(?:,\\s*([+-]?\\d+\\.?\\d*)\\s*)?\\)\\s*$")
    if color_match:
        var r = float(color_match[1])
        var g = float(color_match[2])
        var b = float(color_match[3])
        var a = float(color_match[4]) if color_match[4] else 1.0
        return Color(r, g, b, a)
    
    # Try hex color (e.g., "#ff0000" or "#ff0000ff")
    if str_value.begins_with("#") and (str_value.length() == 7 or str_value.length() == 9):
        var hex = str_value.substr(1)
        if hex.is_valid_hex_number():
            var r = hex.substr(0, 2).hex_to_int() / 255.0
            var g = hex.substr(2, 2).hex_to_int() / 255.0
            var b = hex.substr(4, 2).hex_to_int() / 255.0
            var a = 1.0
            if hex.length() == 8:
                a = hex.substr(6, 2).hex_to_int() / 255.0
            return Color(r, g, b, a)
    
    # Try to parse boolean
    if str_value.to_lower() == "true":
        return true
    if str_value.to_lower() == "false":
        return false
    
    # Try to parse number
    if str_value.is_valid_float():
        var num = float(str_value)
        # Return as int if it's a whole number
        if num == int(num):
            return int(num)
        return num
    
    # Return as string
    return str_value


# Delete a node from a scene
func delete_node(params):
    print("Deleting node...")
    
    # Get parameters
    var scene_path = params.scene_path
    var node_path = params.node_path
    
    # Ensure paths start with res://
    if not scene_path.begins_with("res://"):
        scene_path = "res://" + scene_path
    
    if debug_mode:
        print("Scene path: " + scene_path)
        print("Node path to delete: " + node_path)
    
    # Check if scene file exists
    if not FileAccess.file_exists(scene_path):
        printerr("Scene file does not exist at: " + scene_path)
        quit(1)
    
    # Load the scene
    var scene = load(scene_path)
    if not scene:
        printerr("Failed to load scene: " + scene_path)
        quit(1)
    
    if debug_mode:
        print("Scene loaded successfully")
    
    # Instance the scene to edit
    var scene_root = scene.instantiate()
    if debug_mode:
        print("Scene instantiated")
    
    # Find the node to delete
    var target_node = null
    var parent_node = null
    
    if node_path == "root" or node_path == ".":
        printerr("Cannot delete root node. Delete the entire scene file instead.")
        quit(1)
    else:
        var search_path = node_path
        if search_path.begins_with("root/"):
            search_path = search_path.substr(5)
        elif search_path.begins_with("root"):
            search_path = search_path.substr(4)
        
        if search_path.is_empty():
            printerr("Cannot delete root node. Delete the entire scene file instead.")
            quit(1)
        
        # Get the parent path
        var path_parts = search_path.split("/")
        if path_parts.size() == 1:
            # Direct child of root
            parent_node = scene_root
        else:
            # Nested child
            var parent_path = "/".join(path_parts.slice(0, path_parts.size() - 1))
            parent_node = scene_root.get_node(parent_path)
        
        var node_name = path_parts[path_parts.size() - 1]
        
        if parent_node:
            target_node = parent_node.get_node_or_null(node_name)
        
        if not target_node:
            # Try direct path lookup
            target_node = scene_root.get_node_or_null(search_path)
            if target_node:
                parent_node = target_node.get_parent()
    
    if not target_node:
        printerr("Node not found: " + node_path)
        quit(1)
    
    if not parent_node:
        printerr("Cannot determine parent of node: " + node_path)
        quit(1)
    
    if debug_mode:
        print("Found target node: " + target_node.name)
        print("Parent node: " + parent_node.name)
    
    # Remove the node from its parent
    parent_node.remove_child(target_node)
    target_node.queue_free()
    
    if debug_mode:
        print("Node removed from scene tree")
    
    # Pack and save the scene
    var packed_scene = PackedScene.new()
    var pack_result = packed_scene.pack(scene_root)
    
    if pack_result != OK:
        printerr("Failed to pack scene: " + str(pack_result))
        quit(1)
    
    if debug_mode:
        print("Scene packed successfully")
    
    # Save the scene
    var save_result = ResourceSaver.save(packed_scene, scene_path)
    
    if save_result != OK:
        printerr("Failed to save scene: " + str(save_result))
        quit(1)
    
    if debug_mode:
        print("Scene saved successfully")
    
    # Return success result
    var result = {
        "success": true,
        "scene_path": scene_path,
        "deleted_node": node_path,
        "parent_node": parent_node.name
    }
    print(JSON.stringify(result))
    
    # Cleanup
    scene_root.free()
    
    if debug_mode:
        print("Node deletion complete: " + node_path)
