const fs = require('fs');
const path = require('path');

// Transformation function for a single entry
function transformEntry(entry) {
  return {
    name: entry.name,
    id: entry.id,
    hidden: false,
    typeId: "3557-8ab4-304c-4f6a",
    typeName: "Special Rule",
    characteristics: [
      {
        name: "Description",
        "$text": entry.description,
        typeId: "1eb5-296a-bd06-a87a"
      }
    ]
  };
}

// File paths (change these if your file names are different)
const inputPath = path.join(__dirname, 'Rules.json');
const outputPath = path.join(__dirname, 'output.json');

try {
  // Read and parse the input JSON file
  const rawData = fs.readFileSync(inputPath, 'utf8');
  const inputData = JSON.parse(rawData);

  // Handle both single objects and arrays of objects
  const transformedData = Array.isArray(inputData)
    ? inputData.map(transformEntry)
    : transformEntry(inputData);

  // Write the result to the output JSON file
  fs.writeFileSync(outputPath, JSON.stringify(transformedData, null, 2), 'utf8');
  
  console.log(`Successfully transformed entries and saved to ${outputPath}`);
} catch (error) {
  console.error('Error processing the JSON file:', error.message);
}