@tool
extends EditorPlugin

# MCP Bridge Plugin - Enables external communication with Godot Editor

const PORT := 9742
const HOST := "127.0.0.1"

var tcp_server: TCPServer
var tcp_peer: StreamPeerTCP
var is_running := false
var command_thread: Thread
var command_queue: Array = []
var queue_mutex: Mutex

func _enter_tree():
	print("[MCP Bridge] Initializing...")
	queue_mutex = Mutex.new()
	start_server()
	add_to_group("mcp_bridge")

func _exit_tree():
	print("[MCP Bridge] Shutting down...")
	stop_server()

func start_server():
	if is_running:
		return
	
	tcp_server = TCPServer.new()
	# Godot 4.x: listen() directly binds and starts listening
	var err = tcp_server.listen(PORT, HOST)
	if err != OK:
		push_error("[MCP Bridge] Failed to start server on port %d: %s" % [PORT, err])
		return
	
	is_running = true
	print("[MCP Bridge] Server listening on %s:%d" % [HOST, PORT])
	
	# Start command processing thread
	command_thread = Thread.new()
	command_thread.start(_process_commands)

func stop_server():
	is_running = false
	
	if command_thread and command_thread.is_started():
		command_thread.wait_to_finish()
	
	if tcp_peer:
		tcp_peer.disconnect_from_host()
		tcp_peer = null
	
	if tcp_server:
		tcp_server.stop()
		tcp_server = null
	
	print("[MCP Bridge] Server stopped")

func _process(delta):
	if not is_running:
		return
	
	# Accept new connections
	if tcp_server and tcp_server.is_connection_available():
		if tcp_peer:
			tcp_peer.disconnect_from_host()
		tcp_peer = tcp_server.take_connection()
		print("[MCP Bridge] Client connected")
	
	# Read incoming data
	if tcp_peer and tcp_peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		var available = tcp_peer.get_available_bytes()
		if available > 0:
			var data = tcp_peer.get_string(available)
			_handle_incoming_data(data)

func _handle_incoming_data(data: String):
	# Handle multiple JSON objects (newline delimited)
	for line in data.split("\n"):
		line = line.strip_edges()
		if line.is_empty():
			continue
		
		var json = JSON.new()
		var err = json.parse(line)
		if err == OK:
			queue_mutex.lock()
			command_queue.append(json.get_data())
			queue_mutex.unlock()
		else:
			print("[MCP Bridge] Failed to parse JSON: %s" % line)

func _process_commands():
	while is_running:
		queue_mutex.lock()
		var has_commands = command_queue.size() > 0
		var command = null
		if has_commands:
			command = command_queue.pop_front()
		queue_mutex.unlock()
		
		if command:
			_execute_command(command)
		else:
			OS.delay_msec(10)  # Small delay to prevent busy waiting

func _execute_command(command: Dictionary):
	var cmd_id = command.get("id", "")
	var cmd_type = command.get("type", "")
	var params = command.get("params", {})
	
	print("[MCP Bridge] Executing command: %s" % cmd_type)
	
	var result = {
		"id": cmd_id,
		"success": false,
		"error": "",
		"data": {}
	}
	
	match cmd_type:
		"ping":
			result.success = true
			result.data = {"message": "pong", "godot_version": Engine.get_version_info()}
		
		"get_editor_state":
			result = _cmd_get_editor_state(result)
		
		"get_selection":
			result = _cmd_get_selection(result)
		
		"select_node":
			result = _cmd_select_node(params, result)
		
		"get_scene_tree":
			result = _cmd_get_scene_tree(params, result)
		
		"get_node_properties":
			result = _cmd_get_node_properties(params, result)
		
		"set_node_property":
			result = _cmd_set_node_property(params, result)
		
		"open_scene":
			result = _cmd_open_scene(params, result)
		
		"save_scene":
			result = _cmd_save_scene(result)
		
		"get_open_scenes":
			result = _cmd_get_open_scenes(result)
		
		"inspect_node":
			result = _cmd_inspect_node(params, result)
		
		"execute_code":
			result = _cmd_execute_code(params, result)
		
		_:
			result.error = "Unknown command: %s" % cmd_type
	
	_send_response(result)

func _send_response(response: Dictionary):
	if tcp_peer and tcp_peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		var json_str = JSON.stringify(response) + "\n"
		tcp_peer.put_data(json_str.to_utf8_buffer())

# ============================================================================
# Command Implementations
# ============================================================================

func _cmd_get_editor_state(result: Dictionary) -> Dictionary:
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	result.success = true
	result.data = {
		"current_scene": current_scene.name if current_scene else "",
		"current_scene_path": editor_interface.get_edited_scene_root().scene_file_path if current_scene else "",
		"is_playing": editor_interface.is_playing_scene(),
		"has_selection": _has_selection(),
		"selection_count": _get_selection_count()
	}
	return result

func _cmd_get_selection(result: Dictionary) -> Dictionary:
	var editor_interface = get_editor_interface()
	var selection = editor_interface.get_selection()
	var selected_nodes = selection.get_selected_nodes()
	
	var nodes_info = []
	for node in selected_nodes:
		nodes_info.append({
			"name": node.name,
			"type": node.get_class(),
			"path": _get_node_path(node),
			"scene_path": node.scene_file_path if node.scene_file_path else ""
		})
	
	result.success = true
	result.data = {
		"count": selected_nodes.size(),
		"nodes": nodes_info
	}
	return result

func _cmd_select_node(params: Dictionary, result: Dictionary) -> Dictionary:
	var node_path = params.get("node_path", "")
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var node = current_scene.get_node_or_null(node_path)
	if not node:
		result.error = "Node not found: %s" % node_path
		return result
	
	var selection = editor_interface.get_selection()
	selection.clear()
	selection.add_node(node)
	
	# Try to show the node in the editor
	editor_interface.inspect_object(node)
	
	result.success = true
	result.data = {
		"name": node.name,
		"path": node_path
	}
	return result

func _cmd_get_scene_tree(params: Dictionary, result: Dictionary) -> Dictionary:
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var max_depth = params.get("max_depth", 5)
	var tree_data = _serialize_node_tree(current_scene, 0, max_depth)
	
	result.success = true
	result.data = {
		"root": tree_data,
		"scene_path": current_scene.scene_file_path if current_scene.scene_file_path else ""
	}
	return result

func _cmd_get_node_properties(params: Dictionary, result: Dictionary) -> Dictionary:
	var node_path = params.get("node_path", "")
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var node = current_scene.get_node_or_null(node_path)
	if not node:
		result.error = "Node not found: %s" % node_path
		return result
	
	var include_defaults = params.get("include_defaults", false)
	var properties = []
	
	for property in node.get_property_list():
		var usage = property.get("usage", 0)
		# Filter to only show exported/editor-visible properties
		if (usage & PROPERTY_USAGE_EDITOR) or (usage & PROPERTY_USAGE_DEFAULT):
			var prop_name = property.get("name", "")
			var prop_value = node.get(prop_name)
			
			if not include_defaults and _is_default_value(node, prop_name, prop_value):
				continue
			
			properties.append({
				"name": prop_name,
				"type": property.get("type", 0),
				"type_name": property.get("class_name", ""),
				"value": _serialize_value(prop_value)
			})
	
	result.success = true
	result.data = {
		"node": node.name,
		"type": node.get_class(),
		"properties": properties
	}
	return result

func _cmd_set_node_property(params: Dictionary, result: Dictionary) -> Dictionary:
	var node_path = params.get("node_path", "")
	var property_name = params.get("property", "")
	var value = params.get("value", null)
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var node = current_scene.get_node_or_null(node_path)
	if not node:
		result.error = "Node not found: %s" % node_path
		return result
	
	if not property_name in node:
		result.error = "Property not found: %s" % property_name
		return result
	
	# Deserialize and set value
	var deserialized = _deserialize_value(value, node.get(property_name))
	node.set(property_name, deserialized)
	
	# Mark scene as modified
	editor_interface.mark_scene_as_unsaved()
	
	result.success = true
	result.data = {
		"node": node.name,
		"property": property_name,
		"value": deserialized
	}
	return result

func _cmd_open_scene(params: Dictionary, result: Dictionary) -> Dictionary:
	var scene_path = params.get("scene_path", "")
	var editor_interface = get_editor_interface()
	
	if not FileAccess.file_exists(scene_path):
		result.error = "Scene file not found: %s" % scene_path
		return result
	
	editor_interface.open_scene_from_path(scene_path)
	# Note: open_scene_from_path returns void, so we assume success
	# The scene change will be reflected in the next get_editor_state call
	
	result.success = true
	result.data = {
		"scene_path": scene_path
	}
	return result

func _cmd_save_scene(result: Dictionary) -> Dictionary:
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var scene_path = current_scene.scene_file_path
	if scene_path.is_empty():
		result.error = "Scene has no file path (unsaved)"
		return result
	
	editor_interface.save_scene()
	# Note: save_scene returns void, so we assume success
	
	result.success = true
	result.data = {
		"scene_path": scene_path
	}
	return result

func _cmd_get_open_scenes(result: Dictionary) -> Dictionary:
	var editor_interface = get_editor_interface()
	# Note: This uses internal API, might need adjustment
	var scenes := []
	
	# Get current scene
	var current = editor_interface.get_edited_scene_root()
	if current:
		scenes.append({
			"name": current.name,
			"path": current.scene_file_path if current.scene_file_path else "",
			"is_current": true
		})
	
	result.success = true
	result.data = {
		"scenes": scenes,
		"current_index": 0
	}
	return result

func _cmd_inspect_node(params: Dictionary, result: Dictionary) -> Dictionary:
	var node_path = params.get("node_path", "")
	var editor_interface = get_editor_interface()
	var current_scene = editor_interface.get_edited_scene_root()
	
	if not current_scene:
		result.error = "No scene is currently open"
		return result
	
	var node = current_scene.get_node_or_null(node_path)
	if not node:
		result.error = "Node not found: %s" % node_path
		return result
	
	# Open in inspector
	editor_interface.inspect_object(node)
	
	# Also select in scene tree
	var selection = editor_interface.get_selection()
	selection.clear()
	selection.add_node(node)
	
	result.success = true
	result.data = {
		"name": node.name,
		"type": node.get_class(),
		"path": _get_node_path(node)
	}
	return result

func _cmd_execute_code(params: Dictionary, result: Dictionary) -> Dictionary:
	var code = params.get("code", "")
	
	if code.is_empty():
		result.error = "No code provided"
		return result
	
	# Use Expression to evaluate code in editor context
	var expression = Expression.new()
	var err = expression.parse(code, ["editor"])
	
	if err != OK:
		result.error = "Failed to parse expression: %s" % err
		return result
	
	var output = expression.execute([get_editor_interface()], self)
	
	if expression.has_execute_failed():
		result.error = "Expression execution failed"
		return result
	
	result.success = true
	result.data = {
		"output": _serialize_value(output)
	}
	return result

# ============================================================================
# Helper Functions
# ============================================================================

func _has_selection() -> bool:
	var selection = get_editor_interface().get_selection()
	return selection.get_selected_nodes().size() > 0

func _get_selection_count() -> int:
	var selection = get_editor_interface().get_selection()
	return selection.get_selected_nodes().size()

func _get_node_path(node: Node) -> String:
	if not node:
		return ""
	
	var edited_scene_root = get_editor_interface().get_edited_scene_root()
	if node == edited_scene_root:
		return node.name
	
	return str(node.get_path())

func _serialize_node_tree(node: Node, depth: int, max_depth: int) -> Dictionary:
	var data = {
		"name": node.name,
		"type": node.get_class(),
		"path": _get_node_path(node),
		"children": []
	}
	
	if depth < max_depth:
		for child in node.get_children():
			data.children.append(_serialize_node_tree(child, depth + 1, max_depth))
	elif node.get_child_count() > 0:
		data["has_more_children"] = true
		data["child_count"] = node.get_child_count()
	
	return data

func _is_default_value(node: Node, prop_name: String, value) -> bool:
	# Simplified check - in practice you'd compare with property info defaults
	return false

func _serialize_value(value) -> Variant:
	if value == null:
		return null
	
	match typeof(value):
		TYPE_VECTOR2:
			return {"__type": "Vector2", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"__type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {"__type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_RECT2:
			return {"__type": "Rect2", "x": value.position.x, "y": value.position.y, "w": value.size.x, "h": value.size.y}
		TYPE_TRANSFORM2D:
			return {"__type": "Transform2D", "x": [value.x.x, value.x.y], "y": [value.y.x, value.y.y], "origin": [value.origin.x, value.origin.y]}
		TYPE_OBJECT:
			if value is Resource and value.resource_path:
				return {"__type": "Resource", "path": value.resource_path}
			return str(value)
		TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_FLOAT32_ARRAY:
			return value
		TYPE_DICTIONARY:
			return value
		_:
			return value

func _deserialize_value(value, default_value):
	if value is Dictionary and value.has("__type"):
		match value["__type"]:
			"Vector2":
				return Vector2(value["x"], value["y"])
			"Vector3":
				return Vector3(value["x"], value["y"], value["z"])
			"Color":
				return Color(value["r"], value["g"], value["b"], value.get("a", 1.0))
			"Rect2":
				return Rect2(value["x"], value["y"], value["w"], value["h"])
			"Resource":
				return load(value["path"]) if value.has("path") else null
			_:
				return default_value
	
	# Handle string representations for Vector/Color
	if value is String and default_value is Vector2:
		var parts = value.trim_prefix("(").trim_suffix(")").split(",")
		if parts.size() >= 2:
			return Vector2(float(parts[0]), float(parts[1]))
	
	if value is String and default_value is Color:
		if value.begins_with("#"):
			return Color(value)
		if value.begins_with("Color"):
			# Parse Color(r, g, b, a) format
			var regex = RegEx.new()
			regex.compile(r"Color\(([^)]+)\)")
			var regex_match = regex.search(value)
			if regex_match:
				var nums = regex_match.get_string(1).split(",")
				if nums.size() >= 3:
					var a = 1.0
					if nums.size() > 3:
						a = float(nums[3])
					return Color(float(nums[0]), float(nums[1]), float(nums[2]), a)
	
	return value if value != null else default_value
