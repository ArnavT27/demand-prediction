const express = require('express');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Store for model results
let lastPredictionResults = null;
let modelStatus = 'idle'; // idle, training, ready, error

// Helper function to run Python script
function runPythonScript(scriptPath, args = []) {
    return new Promise((resolve, reject) => {
        const python = spawn('python3', [scriptPath, ...args]);
        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        python.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Python script failed with code ${code}: ${stderr}`));
            }
        });
    });
}

// Helper function to read CSV file
function readCSV(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

// Routes

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        modelStatus,
        timestamp: new Date().toISOString() 
    });
});

// Get model status
app.get('/api/status', (req, res) => {
    res.json({ 
        modelStatus,
        hasResults: lastPredictionResults !== null,
        timestamp: new Date().toISOString()
    });
});

// Upload training data
app.post('/api/upload/train', upload.single('trainFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Move uploaded file to train.csv
        fs.renameSync(req.file.path, 'train.csv');
        
        res.json({ 
            message: 'Training data uploaded successfully',
            filename: req.file.originalname,
            size: req.file.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Upload test data
app.post('/api/upload/test', upload.single('testFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        // Move uploaded file to test.csv
        fs.renameSync(req.file.path, 'test.csv');
        
        res.json({ 
            message: 'Test data uploaded successfully',
            filename: req.file.originalname,
            size: req.file.size
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Train model and generate predictions
app.post('/api/train', async (req, res) => {
    try {
        // Check if required files exist
        if (!fs.existsSync('train.csv') || !fs.existsSync('test.csv')) {
            return res.status(400).json({ 
                error: 'Missing required files. Please upload both train.csv and test.csv first.' 
            });
        }

        modelStatus = 'training';
        
        // Run the Python demand forecasting script
        const output = await runPythonScript('models/demand_forecasting.py');
        
        // Check if submission file was created
        if (fs.existsSync('submission.csv')) {
            const predictions = await readCSV('submission.csv');
            lastPredictionResults = predictions;
            modelStatus = 'ready';
            
            res.json({
                message: 'Model trained successfully',
                output: output.trim(),
                predictionsCount: predictions.length,
                samplePredictions: predictions.slice(0, 5) // Show first 5 predictions
            });
        } else {
            modelStatus = 'error';
            res.status(500).json({ error: 'Model training completed but no predictions generated' });
        }
    } catch (error) {
        modelStatus = 'error';
        res.status(500).json({ error: error.message });
    }
});

// Get predictions
app.get('/api/predictions', async (req, res) => {
    try {
        if (!fs.existsSync('submission.csv')) {
            return res.status(404).json({ error: 'No predictions available. Train the model first.' });
        }

        const predictions = await readCSV('submission.csv');
        res.json({
            predictions,
            count: predictions.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get specific prediction by ID
app.get('/api/predictions/:id', async (req, res) => {
    try {
        if (!fs.existsSync('submission.csv')) {
            return res.status(404).json({ error: 'No predictions available. Train the model first.' });
        }

        const predictions = await readCSV('submission.csv');
        const prediction = predictions.find(p => p.id === req.params.id);
        
        if (!prediction) {
            return res.status(404).json({ error: 'Prediction not found' });
        }

        res.json(prediction);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download predictions as CSV
app.get('/api/download/predictions', (req, res) => {
    const filePath = path.join(__dirname, 'submission.csv');
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'No predictions file available' });
    }

    res.download(filePath, 'demand_predictions.csv');
});

// Get targeted offers (if available)
app.get('/api/offers', async (req, res) => {
    try {
        if (!fs.existsSync('targeted_offers.csv')) {
            return res.status(404).json({ 
                error: 'No targeted offers available. This requires stock data to be processed.' 
            });
        }

        const offers = await readCSV('targeted_offers.csv');
        res.json({
            offers,
            count: offers.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Predict for single item
app.post('/api/predict/single', async (req, res) => {
    try {
        const { store, item, date } = req.body;
        
        if (!store || !item || !date) {
            return res.status(400).json({ 
                error: 'Missing required fields: store, item, date' 
            });
        }

        // Create temporary test file for single prediction
        const singleTestData = `id,store,item,date\n1,${store},${item},${date}`;
        fs.writeFileSync('temp_test.csv', singleTestData);

        // Backup original test file if it exists
        if (fs.existsSync('test.csv')) {
            fs.renameSync('test.csv', 'test_backup.csv');
        }
        
        // Use temp file as test data
        fs.renameSync('temp_test.csv', 'test.csv');

        // Run prediction
        await runPythonScript('models/demand_forecasting.py');

        // Read result
        const predictions = await readCSV('submission.csv');
        const prediction = predictions[0];

        // Restore original test file
        if (fs.existsSync('test_backup.csv')) {
            fs.renameSync('test_backup.csv', 'test.csv');
        }

        res.json({
            store,
            item,
            date,
            predictedSales: parseInt(prediction.sales),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        // Restore original test file in case of error
        if (fs.existsSync('test_backup.csv')) {
            fs.renameSync('test_backup.csv', 'test.csv');
        }
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Demand Forecasting API Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 API Documentation:`);
    console.log(`   POST /api/upload/train - Upload training data`);
    console.log(`   POST /api/upload/test - Upload test data`);
    console.log(`   POST /api/train - Train model and generate predictions`);
    console.log(`   GET  /api/predictions - Get all predictions`);
    console.log(`   GET  /api/predictions/:id - Get specific prediction`);
    console.log(`   POST /api/predict/single - Predict for single item`);
    console.log(`   GET  /api/download/predictions - Download predictions CSV`);
});

module.exports = app;