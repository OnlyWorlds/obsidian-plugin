# OnlyWorlds Plugin for Obsidian

This plugin provides complete workflows for world creation, building, and management, fully compatible with the [OnlyWorlds](https://www.onlyworlds.com) framework.

It functions as a standalone tool for organizing worlds, and facilitates the transfer of these worlds across other tools within the framework.

## OnlyWorlds

OnlyWorlds is an open-source data standard for worldbuilding.

Public release planned for December 2025.

Full documentation at [onlyworlds.github.io](https://onlyworlds.github.io/).
 
 ## Configuring Hotkeys

This plugin requires a custom hotkey to link element fields

Suggestion: CTRL/CMD + SHIFT + L

To set up:
1. Open Obsidian
2. Go to `Settings` -> `Hotkeys`
3. Search for "Link Elements"
4. Click on the + symbol, then input a combination
 
## Getting Started 

Create a free account at https://onlyworlds.com. Note and/or change your PIN in your profile section

Use the Create World command (Ctrl + P) in Obsidian

If necessary folders and/or files are missing, this command will automatically import and create them

A folder 'OnlyWorlds' will be created at the top of your vault. This folder must remain at the top of your vault for the plugin to function

Use the Create Element command to fill your world with elements of [various categories](https://onlyworlds.github.io/docs/framework/categories.html)

You can upload your world(s) to the onlyworlds.com server using the 'Export World' or 'Save Element' commands

Alternatively, you can copy your full world as JSON data directly to your clipboard.  

## Folder Structure
- **OnlyWorlds/**: Parent folder at top of vault
	- **PluginFiles**:
		- **Handlebars/**: Should not be modified
    	- **Templates/**: Should not be modified
    - **Worlds/**: User worlds directory
        - **WorldOne/**:  
            - **Elements/**: World elements, represented as notes
            - **World**: World configuration file 
            - **World Data**: Output file for Copy World command 
        - **WorldTwo/**:  
            - ..
    - **README**: ..
    - **Settings**: A few plugin options

## Commands 
- `Create World` Create a new world file and necessary files
- `Import World` Load a world from the onlyworlds.com server into your vault (overwrites existing worlds with the same API key)
- `Export World` Send world data to the onlyworlds.com server
- `Save Element` Upload your curently opened element note to the onlyworlds.com server
- `Paste World`  Create necessary files and world directly from a World Data string - `Import World` Create necessary files and world from online World Data using a world key
- `Copy World` Create world data string from a world in your vault
- `Rename World`  Safely change the name of your world  
- `Validate World`  Manual call that is forced on export for ensuring correct content and formatting
- `Create Element`  Choose a category, then enter a name to create 

## Element Editing
- **Normal fields**: Accept text of any length

- **Italic fields**: Numeric only. Hover or click the field to see potential maximum value

- **Link fields** (underlined): Place cursor behind, then use {your-link-elements-hotkey} to view pickable elements. Light blue for single link, dark for multi link

### Editing Guidelines
- The **Name** field of an element must match the note name
- Each element must have a unique Id, generated automatically with **Create Element** command. Try to avoid manual duplication or creation. But if you do, make sure to generate a [new UUIDv7](https://www.uuidgenerator.net/version7)

## Settings 
- Write the **active world** name for ongoing work 
- Enable 18 category-specific commands for creating elements
- Set the default category for creating new elements
- Add your onlyworlds.com email for convenience
   
## Contact and Contribution
Feedback and contribution for this plugin or anything OnlyWorlds is always welcome, via  [discord](https://discord.gg/twCjqvVBwb) or [github](https://github.com/OnlyWorlds/OnlyWorlds) or [reddit](https://www.reddit.com/r/OnlyWorlds/) or [email](info@onlyworlds.com)

  
