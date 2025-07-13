const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store for model results
let modelStatus = 'idle'; // idle, training, ready, error
let lastTrainingTime = null;

// Helper function to run Python script
function runPythonScript(scriptPath) {
    return new Promise((resolve, reject) => {
        const python = spawn('python', [scriptPath]);
        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log('Python output:', data.toString());
        });

        python.stderr.on('data', (data) => {
            stderr += data.toString();
            console.error('Python error:', data.toString());
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
        if (!fs.existsSync(filePath)) {
            reject(new Error(`File ${filePath} not found`));
            return;
        }
        
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
        lastTrainingTime,
        timestamp: new Date().toISOString() 
    });
});

// Get model status
app.get('/api/status', (req, res) => {
    const hasTrainData = fs.existsSync('train.csv');
    const hasTestData = fs.existsSync('test.csv');
    const hasPredictions = fs.existsSync('submission.csv');
    
    res.json({ 
        modelStatus,
        hasTrainData,
        hasTestData,
        hasPredictions,
        lastTrainingTime,
        timestamp: new Date().toISOString()
    });
});

// Train model and generate predictions
app.post('/api/train', async (req, res) => {
    try {
        // Check if required files exist
        if (!fs.existsSync('train.csv')) {
            return res.status(400).json({ 
                error: 'train.csv not found. Please ensure training data is available.' 
            });
        }
        
        if (!fs.existsSync('test.csv')) {
            return res.status(400).json({ 
                error: 'test.csv not found. Please ensure test data is available.' 
            });
        }

        modelStatus = 'training';
        console.log('Starting model training...');
        
        // Run the Python demand forecasting script
        const output = await runPythonScript('models/demand_forecasting.py');
        
        // Check if submission file was created
        if (fs.existsSync('submission.csv')) {
            const predictions = await readCSV('submission.csv');
            modelStatus = 'ready';
            lastTrainingTime = new Date().toISOString();
            
            console.log(`Model training completed. Generated ${predictions.length} predictions.`);
            
            res.json({
                message: 'Model trained successfully',
                output: output.trim(),
                predictionsCount: predictions.length,
                samplePredictions: predictions.slice(0, 5), // Show first 5 predictions
                trainingTime: lastTrainingTime
            });
        } else {
            modelStatus = 'error';
            res.status(500).json({ 
                error: 'Model training completed but no predictions file generated',
                output: output.trim()
            });
        }
    } catch (error) {
        modelStatus = 'error';
        console.error('Training error:', error.message);
        res.status(500).json({ 
            error: error.message,
            details: 'Check server logs for more information'
        });
    }
});

// Get all predictions
app.get('/api/predictions', async (req, res) => {
    try {
        if (!fs.existsSync('submission.csv')) {
            return res.status(404).json({ 
                error: 'No predictions available. Train the model first.' 
            });
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
            return res.status(404).json({ 
                error: 'No predictions available. Train the model first.' 
            });
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
        return res.status(404).json({ 
            error: 'No predictions file available. Train the model first.' 
        });
    }

    res.download(filePath, 'demand_predictions.csv');
});

// Get prediction statistics
app.get('/api/stats', async (req, res) => {
    try {
        if (!fs.existsSync('submission.csv')) {
            return res.status(404).json({ 
                error: 'No predictions available. Train the model first.' 
            });
        }

        const predictions = await readCSV('submission.csv');
        const sales = predictions.map(p => parseInt(p.sales)).filter(s => !isNaN(s));
        
        const stats = {
            count: predictions.length,
            totalPredictedSales: sales.reduce((sum, s) => sum + s, 0),
            averageSales: sales.reduce((sum, s) => sum + s, 0) / sales.length,
            minSales: Math.min(...sales),
            maxSales: Math.max(...sales),
            timestamp: new Date().toISOString()
        };

        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Demand Forecasting API running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📈 API Endpoints:`);
    console.log(`   POST /api/train - Train model and generate predictions`);
    console.log(`   GET  /api/predictions - Get all predictions`);
    console.log(`   GET  /api/predictions/:id - Get specific prediction`);
    console.log(`   GET  /api/stats - Get prediction statistics`);
    console.log(`   GET  /api/download/predictions - Download predictions CSV`);
    console.log(`   GET  /api/status - Get current model status`);
    
    // Check if data files exist on startup
    const hasTrainData = fs.existsSync('train.csv');
    const hasTestData = fs.existsSync('test.csv');
    
    console.log(`📁 Data files status:`);
    console.log(`   train.csv: ${hasTrainData ? '✅ Found' : '❌ Missing'}`);
    console.log(`   test.csv: ${hasTestData ? '✅ Found' : '❌ Missing'}`);
    
    if (hasTrainData && hasTestData) {
        console.log(`✨ Ready to train! Send POST request to /api/train`);
    } else {
        console.log(`⚠️  Please ensure train.csv and test.csv are in the project root`);
    }
});

module.exports = app;