import { PinInputModal } from 'Modals/PinInputModal'; // This modal will be created next
import { App, Notice, TFile, normalizePath, requestUrl } from 'obsidian';

// Define the structure for element data (adapt as needed based on actual fields)
interface ElementData {
    id: string;
    name: string;
    [key: string]: any; // Allow other fields
}

// Define the structure for world file data (adapt as needed)
interface WorldFileData {
    api_key?: string;
    [key: string]: any;
}

export class SaveElementCommand {
    app: App;
    // DEVELOPMENT: Point to local server
    private apiBaseUrl = 'http://127.0.0.1:8000/api/worldapi/';
    // PRODUCTION: Point to production server
    // private apiBaseUrl = 'https://www.onlyworlds.com/api/worldapi/';
   // private apiBaseUrl = 'https://onlywords.pythonanywhere.com/api/worldapi/';


    constructor(app: App) {
        this.app = app;
    }

    async execute() {
        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile || !(activeFile instanceof TFile)) {
            new Notice("No active file selected or it's not a valid file.");
            return;
        }

        // 1. Validate Path and Extract Info
        const pathInfo = this.extractPathInfo(activeFile.path);
        if (!pathInfo) {
            new Notice("The current file is not a valid OnlyWorlds element note.");
            console.log(`Invalid path: ${activeFile.path}`);
            return;
        }
        const { worldName, category } = pathInfo;

        // 2. Read and Parse Element Content
        const fileContent = await this.app.vault.read(activeFile);
        const elementData = this.parseElementContent(fileContent);

        if (!elementData || !elementData.id) {
            new Notice("Could not parse element data or find element ID in the note.");
            console.error("Parsing error or missing ID in:", activeFile.path, elementData);
            return;
        }
        const elementUuid = elementData.id;

        // 3. Get API Key from World.md
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
        let apiKey: string | undefined;
        try {
            const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);
            if (worldFile instanceof TFile) {
                const worldFileContent = await this.app.vault.read(worldFile);
                const worldData = this.parseWorldFile(worldFileContent);
                apiKey = worldData?.api_key;
            } else {
                 throw new Error("World.md file not found or is a folder.");
            }
             if (!apiKey) {
                 throw new Error("API Key not found in World.md.");
            }
        } catch (error) {
            console.error(`Error accessing or parsing World.md for ${worldName}:`, error);
            new Notice(`Error getting API key: ${error instanceof Error ? error.message : 'Unknown error'}. Please check World.md.`);
            return;
        }


        // 4. Prompt for PIN
        new PinInputModal(this.app, async (pin: string | null) => {
            if (!pin) {
                new Notice("Save cancelled: PIN not provided.");
                return;
            }

            // 5. Construct URL and Payload
            const apiUrl = `${this.apiBaseUrl}${category.toLowerCase()}/${elementUuid}/`;
            // Payload now only contains the element data itself
            const payload = {
                ...elementData
            };

            // Remove api_key and pin from the payload object if they were added by spread
            delete payload.api_key;
            delete payload.pin;

            console.log("Sending Payload:", payload);
            // 6. Make API Call
            try {
                new Notice(`Saving ${category} "${elementData.name || elementUuid}"...`);
                const response = await requestUrl({
                    url: apiUrl,
                    method: 'PUT', // Method should still be POST as per your API docs for upsert
                    headers: {
                        'Content-Type': 'application/json',
                        'API-Key': apiKey, // Add API Key to headers
                        'API-Pin': pin     // Add PIN to headers
                    },
                    body: JSON.stringify(payload), // Send only element data in body
                });

                // 7. Handle Response
                if (response.status === 200 || response.status === 201) {
                    // 200 OK (updated), 201 Created
                    const responseData = response.json;
                    const message = responseData?.message || `Element ${response.status === 201 ? 'created' : 'updated'} successfully.`;
                    new Notice(message);
                     // Optional: Update the local note if API returns new data (e.g., updated timestamp)
                     // This would require parsing the response and editing the file.
                } else {
                     // Handle specific known errors based on status code
                     this.handleApiError(response.status, response.json);
                }

            } catch (error) {
                console.error('Error saving element via API:', error);
                 if (error && typeof error === 'object' && 'status' in error) {
                    // Attempt to handle errors from requestUrl framework itself
                    this.handleApiError(error.status as number, error);
                 } else if (error instanceof Error) {
                    new Notice(`Network or processing error: ${error.message}`);
                 } else {
                    new Notice('An unknown error occurred while saving the element.');
                 }
            }

        }).open();
    }

    // Helper to extract World Name and Category from path
    extractPathInfo(filePath: string): { worldName: string; category: string } | null {
        // Example path: OnlyWorlds/Worlds/MyWorld/Elements/Characters/Hero.md
        const pattern = /^OnlyWorlds\/Worlds\/([^\/]+)\/Elements\/([^\/]+)\/.+\.md$/i;
        const match = filePath.match(pattern);
        if (match && match[1] && match[2]) {
            return { worldName: match[1], category: match[2] };
        }
        return null;
    }

    // Simplified parser for element content (adapt based on your actual note structure)
    // This needs to reliably find the 'Id' field generated by CreateElementCommand
    parseElementContent(content: string): ElementData | null {
        const data: Partial<ElementData> = {};
        const lines = content.split('\n');

        // Example line: - <span ...>Id</span>: 123e4567-e89b-12d3-a456-426614174000
        const idRegex = /Id<\/span>:\s*([a-f0-9\-]{36})/; // Basic UUID v7 regex
        const nameRegex = /Name<\/span>:\s*(.+)/; // Basic Name regex
        // Add other regex or parsing logic for other fields as needed

        let idFound = false;
        for (const line of lines) {
             // Find ID
            const idMatch = line.match(idRegex);
            if (idMatch && idMatch[1]) {
                data.id = idMatch[1].trim();
                 idFound = true;
                continue; // Move to next line once ID is found
            }

            // Find Name
            const nameMatch = line.match(nameRegex);
             if (nameMatch && nameMatch[1]) {
                 data.name = nameMatch[1].trim();
                 continue;
             }

            // Add parsing for other fields...
            // Example: - <span ...>Description</span>: Some text
            // const descMatch = line.match(/Description<\/span>:\s*(.+)/);
            // if (descMatch && descMatch[1]) {
            //     data.description = descMatch[1].trim();
            // }
        }

        // Return data only if ID was found
        return idFound ? (data as ElementData) : null;
    }

    // Simplified parser for World.md (adapt as needed)
    parseWorldFile(content: string): WorldFileData | null {
        const data: WorldFileData = {};
        // Corrected Regex to match "- **API Key:** digits"
        const apiKeyRegex = /- \*\*API Key:\*\* (\d+)/; 

        const match = content.match(apiKeyRegex);
        if (match && match[1]) {
            data.api_key = match[1].trim();
        }
        // Add parsing for other World fields if needed
        return data;
    }

     // Helper to provide user-friendly messages for common API errors
     handleApiError(status: number, responseData: any) {
        let message = `Error saving element (Status ${status}).`;
        const responseMessage = responseData?.message || responseData?.detail || ''; // Check common error message fields

        switch (status) {
            case 400:
                message = `Bad Request: ${responseMessage || 'Invalid data sent.'}`;
                break;
            case 401: // Unauthorized (though API uses 403)
            case 403: // Forbidden
                 message = `Authentication Failed: ${responseMessage || 'Invalid API Key or PIN.'}`;
                break;
             case 404: // Not Found
                 message = `Not Found: ${responseMessage || 'Element UUID or API endpoint not found.'}`;
                 break;
            case 429: // Too Many Requests
                message = `Rate Limit Exceeded: ${responseMessage || 'Please try again later.'}`;
                break;
            case 500: // Internal Server Error
            default:
                 message = `Server Error (Status ${status}): ${responseMessage || 'Failed to save element on the server.'}`;
                break;
        }
        console.error("API Error Details:", responseData);
        new Notice(message);
    }
} 