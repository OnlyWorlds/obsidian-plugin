import { Category } from "enums";




// src/GraphViewExtensions.ts
export class GraphViewExtensions {
    constructor(private app: any, private plugin: any) {}

    initializeGraphView() {
        this.setupNodeStyling();
        this.setupEventListeners();
        this.reapplyStyles();
    }
    private reapplyStyles() {
        setTimeout(() => {
            this.setupNodeStyling();
        }, 500); // Adjust timing as necessary
    }
    private setupNodeStyling() {
        const graph = this.app.internalGraphView;
        if (!graph) return;
    
        graph.nodes.forEach((node: GraphNode) => {
            if (node.domElement) { // Check if domElement is not undefined
                const categoryClass = `color-fill-${this.getCategoryClass(node.data.category)}`;
                node.domElement.classList.add(categoryClass);
            } else {
           
            }
        });
    }
    
    
    private getCategoryClass(category: Category): string {
        switch (category) {
            case Category.Character:
                return 'character';
            case Category.Location:
                return 'location';
            case Category.Event:
                return 'event';
            default:
                return 'default'; // Default class for categories not explicitly handled
        }
    }

    private setupEventListeners() {
        const graph = this.app.internalGraphView; // Adjust based on actual Obsidian API
        if (!graph) return;
    
        graph.on('nodeClick', (node: GraphNode) => {
            this.handleNodeClick(node);
        });
    }

    private getColorForCategory(category: Category): string {
        switch (category) {
            case Category.Character:
                return 'blue';
            case Category.Location:
                return 'green';
            case Category.Event:
                return 'red';
            default:
                return 'grey'; // Default color if category is undefined or not recognized
        }
    }

    private handleNodeClick(node: any) {
        // Example action on node click
       //  console.log(`Node clicked: ${node.data.name}`);
        // You can expand this method to show a modal, details pane, or other interactive elements
    }

    // You can add more methods here to handle other interactions or data processing needs
}
// Define an interface for the structure of your node data
interface NodeData {
    category: Category;
    name?: string; // Include other properties as required
}

// Define a Node interface if it's not already defined by Obsidian
interface GraphNode {
    data: NodeData;
    style: {
        fill: string;
        stroke: string;
    };
    domElement?: HTMLElement; // Optionally mark it as potentially undefined
}