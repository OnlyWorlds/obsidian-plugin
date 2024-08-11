# OnlyWorlds Plugin for Obsidian

This plugin provides complete workflows for world creation, building, and management, fully compatible with the [OnlyWorlds](https://www.onlyworlds.com) framework

It functions as a standalone tool for organizing worlds and also facilitates the transfer of these worlds across various other tools and games

More information about OnlyWorlds in this [technical documentation](https://onlyworlds.github.io)

 
## Getting Started 

Create a world and required structures with the Create World command (Ctrl + P)

Use Create Element to fill your world with elements of [various categories](https://onlyworlds.github.io/docs/framework/categories.html)

Integrate existing world content, or create new, by shaping elements through their attribute fields. Join community [discussions](https://github.com/OnlyWorlds/OnlyWorlds/discussions) on improving  field definitions

Convert your worlds into a shippable JSON data format for local copy and online use, with various [tools](https://onlyworlds.github.io/docs/tools/) currently available

## Folder Structure
- **OnlyWorlds/**: Parent folder at top of vault
    - **Templates/**: Should not be modified
    - **Worlds/**: Directory for user worlds 
        - **WorldOne/**:  
            - **Elements/**: Elements for the user to edit
            - **World**: World configuration file 
            - **World Data**: Output file for Copy World command (in JSON)
        - **WorldTwo/**:  
            - ..
    - **README**: ..
    - **Settings**: A few plugin options

## Commands 
- `Create World` Create a new world file and necessary files
- `Paste World`  Create necessary files and world directly from a World Data string - `Import World` Create necessary files and world from online World Data using a world key
- `Copy World` Create World Data string for a world in your vault
- `Export World` Send World Data of your world online using a world key
- `Rename World`  Alter the name of your world (safely)
- `Validate World`  Manual call that is forced on export for ensuring correct content and formatting
 - `Create Element`  Choose a category, then enter a name to create
 - `Create {Category}`  Enable 18 direct category creation commands in Settings  

## Element Editing
- **Normal fields**: Accept text of any length

- **Italic fields**: Numeric only. Hover or click the field to see potential maximum value

- **Link fields** (underlined): Place cursor behind, then Ctrl + Shift + L to view pickable elements. Light blue for single reference, dark multi

### Editing Guidelines
- The **Name** field of an element must match the note name
- Each element must have a unique Id, generated automatically with **Create Element** command. When duplicating manually, ensure to generate a [new UUIDv7](https://www.uuidgenerator.net/version7)

## Settings 
- Write the **active world** name for ongoing work 
- Enable 18 category-specific commands for creating elements 
   
## Contact and Contribution
Feedback and contribution for this plugin or anything OnlyWorlds is always welcome, via  [discord](https://discord.gg/twCjqvVBwb) or [github](https://github.com/OnlyWorlds/OnlyWorlds) or [reddit](https://www.reddit.com/r/OnlyWorlds/) or [email](onlyworldsdev@gmail.com)

  
