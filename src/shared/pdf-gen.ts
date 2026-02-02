import { jsPDF } from "jspdf";

/**
 * Generates a Base64 encoded PDF containing an 8x8 pseudo-random grid.
 * The pattern is deterministically generated based on the current Unix timestamp.
 * 
 * Colors:
 * - OFF: (255, 255, 255)
 * - ON:  (254, 254, 254)
 */
export const generateUnixTimePseudoQrPdf = (): string => {
  // 1. Get Unix Time (seconds) as the seed
  const seed = Math.floor(Date.now() / 1000);

  // 2. Create a seeded Random Number Generator (LCG Algorithm)
  // Standard Math.random() cannot be seeded, so we use a custom function.
  const seededRandom = (s: number) => {
    let state = s;
    return () => {
      // LCG constants (Numerical Recipes)
      state = (1664525 * state + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  };

  const rng = seededRandom(seed);

  // 3. Initialize PDF
  // We create a small square PDF (e.g., 80mm x 80mm)
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "px",
    format: [16, 16] 
  });

  const gridSize = 8;
  const cellSize = 10; // 10mm per block

  // 4. Draw the 8x8 Grid
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      // Generate random float 0-1 based on time seed
      const randomVal = rng();
      
      // Threshold for "On" vs "Off" (50% chance)
      const isDot = randomVal > 0.5;

      if (isDot) {
        // The "Dot" color: (254, 254, 254)
        doc.setFillColor(254, 254, 254);
      } else {
        // The "Background" color: (255, 255, 255)
        doc.setFillColor(255, 255, 255);
      }

      // Draw the rectangle (x, y, width, height, style='F' for filled)
      doc.rect(col * cellSize, row * cellSize, cellSize, cellSize, "F");
    }
  }

  // 5. Output as Base64 Data URI
  // Format: "data:application/pdf;filename=generated.pdf;base64,JVBERi0..."
  const base64Output = doc.output('datauristring');
  const rawBase64 = base64Output.split(',')[1];

  return rawBase64;

};

// --- Usage Example ---
/*try {
  const result = generateUnixTimePseudoQrPdf();
  console.log("Generation Successful.");
  console.log("Unix Timestamp used:", Math.floor(Date.now() / 1000));
  console.log("Output (Truncated):", result.substring(0, 50) + "...");
} catch (error) {
  console.error("Error generating PDF:", error);
}*/