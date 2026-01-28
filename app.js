
require('dotenv').config();

const express = require('express');
const ejs = require('ejs');
const pg = require('pg');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const pgSession = require('connect-pg-simple')(session);
const sharp = require('sharp');
const NodeCache = require('node-cache');
const flash = require('express-flash');

const JUDETE = [
  "Alba", "Arad", "Argeș", "Bacău", "Bihor", "Bistrița-Năsăud", "Botoșani", "Brașov", 
  "Brăila", "București", "Buzău", "Caraș-Severin", "Călărași", "Cluj", "Constanța", 
  "Covasna", "Dâmbovița", "Dolj", "Galați", "Giurgiu", "Gorj", "Harghita", "Hunedoara", 
  "Ialomița", "Iași", "Ilfov", "Maramureș", "Mehedinți", "Mureș", "Neamț", "Olt", 
  "Prahova", "Satu Mare", "Sălaj", "Sibiu", "Suceava", "Teleorman", "Timiș", "Tulcea", 
  "Vâlcea", "Vaslui", "Vrancea"
];

const GENRES = [
  "Muzică ușoară", "Muzică populară", "Muzică de petrecere", 
  "Muzică lăutărească", "DJ", "Orchestra", "Violonist", "Manele"
];

// ============= LOGGING SETUP =============
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'artistdirect' },
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ]
});

// Add console transport in non-production environments
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Configure Supabase Storage
let supabase = null;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = 'uploads'; // Name of the storage bucket

// Initialize Supabase Storage (works in both development and production)
logger.info('\n=== SUPABASE STORAGE INITIALIZATION ===');
logger.info(`SUPABASE_URL from env: ${SUPABASE_URL ? 'SET (' + SUPABASE_URL.substring(0, 30) + '...)' : 'NOT SET'}`);
logger.info(`SUPABASE_ANON_KEY from env: ${process.env.SUPABASE_ANON_KEY ? 'SET (length: ' + process.env.SUPABASE_ANON_KEY.length + ')' : 'NOT SET'}`);
logger.info(`SUPABASE_SERVICE_ROLE_KEY from env: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'SET (length: ' + process.env.SUPABASE_SERVICE_ROLE_KEY.length + ')' : 'NOT SET'}`);
logger.info(`SUPABASE_KEY (resolved): ${SUPABASE_KEY ? 'SET (length: ' + SUPABASE_KEY.length + ')' : 'NOT SET'}`);

if (SUPABASE_URL && SUPABASE_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        logger.info('✅ Supabase Storage initialized successfully');
        logger.info(`   URL: ${SUPABASE_URL}`);
        logger.info(`   Bucket: ${STORAGE_BUCKET}`);
        logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    } catch (error) {
        logger.error('❌ Error initializing Supabase client:', error);
        supabase = null;
    }
} else {
    if (process.env.NODE_ENV === 'production') {
        logger.error('❌ CRITICAL: Supabase Storage not configured in production!');
        logger.error('   Photos will be lost on server restart.');
        logger.error('   Please set SUPABASE_URL and SUPABASE_ANON_KEY environment variables in Render.');
    } else {
        logger.warn('⚠️  Supabase Storage not configured. Using local storage (files will be lost on restart).');
        logger.warn('   To use Supabase Storage locally, add to .env file:');
        logger.warn('   SUPABASE_URL=https://xxxxx.supabase.co');
        logger.warn('   SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
        logger.warn('   Make sure .env file is in the project root (same folder as app.js)');
        logger.warn('   Then RESTART your server!');
    }
}
logger.info('========================================\n');

// ============= CACHE SETUP =============
const cache = new NodeCache({ 
    stdTTL: 300, // 5 minutes default TTL
    checkperiod: 60, // Check for expired keys every minute
    useClones: false
});

// ============= IMAGE OPTIMIZATION =============
async function optimizeImage(buffer, maxWidth = 1920, maxHeight = 1920, quality = 85) {
    try {
        const image = sharp(buffer);
        const metadata = await image.metadata();
        
        // Validate it's actually an image
        if (!metadata.format || !['jpeg', 'jpg', 'png', 'webp', 'gif'].includes(metadata.format)) {
            throw new Error('Invalid image format');
        }
        
        // Check dimensions
        if (metadata.width > 5000 || metadata.height > 5000) {
            throw new Error('Image dimensions too large (max 5000x5000)');
        }
        
        // Auto-rotate based on EXIF orientation data (fixes upside-down images)
        // This removes EXIF orientation and rotates the actual image data
        let processedImage = image.rotate();
        
        // Resize if needed
        if (metadata.width > maxWidth || metadata.height > maxHeight) {
            processedImage = processedImage.resize(maxWidth, maxHeight, {
                fit: 'inside',
                withoutEnlargement: true
            });
        }
        
        // Optimize based on format
        if (metadata.format === 'png') {
            processedImage = processedImage.png({ quality, compressionLevel: 9 });
        } else if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            processedImage = processedImage.jpeg({ quality, mozjpeg: true });
        } else if (metadata.format === 'webp') {
            processedImage = processedImage.webp({ quality });
        }
        
        return await processedImage.toBuffer();
    } catch (error) {
        logger.error('Error optimizing image:', error);
        throw error;
    }
}

// Generate thumbnail (for gallery)
async function generateThumbnail(buffer, size = 300) {
    try {
        return await sharp(buffer)
            .resize(size, size, {
                fit: 'cover',
                position: 'center'
            })
            .jpeg({ quality: 80 })
            .toBuffer();
    } catch (error) {
        logger.error('Error generating thumbnail:', error);
        throw error;
    }
}

// ============= FILE VALIDATION MIDDLEWARE =============
function validateImageFile(req, res, next) {
    if (!req.file) {
        return next();
    }
    
    const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    const maxSize = 10 * 1024 * 1024; // 10MB
    
    // Check MIME type
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Invalid file type. Only images (JPEG, PNG, WebP, GIF) are allowed.' });
    }
    
    // Check file size
    if (req.file.size > maxSize) {
        return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
    }
    
    // Validate file content (check magic bytes)
    const buffer = req.file.buffer;
    const isJPEG = buffer[0] === 0xFF && buffer[1] === 0xD8;
    const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    const isGIF = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
    const isWebP = buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
    
    if (!isJPEG && !isPNG && !isGIF && !isWebP) {
        return res.status(400).json({ error: 'Invalid image file. File content does not match image format.' });
    }
    
    next();
}

// Configure multer to use memory storage (we'll upload directly to Supabase)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only images are allowed.'), false);
        }
    }
});

// Ensure uploads directory exists (for local development fallback)
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
    logger.info('✅ Created uploads directory:', uploadsDir);
}

// Helper function to upload file to Supabase Storage
async function uploadToSupabase(file, folder = 'uploads') {
    // Debug: Log Supabase configuration status
    logger.info('=== uploadToSupabase called ===');
    logger.info(`supabase client exists: ${!!supabase}`);
    logger.info(`SUPABASE_URL exists: ${!!SUPABASE_URL}`);
    logger.info(`SUPABASE_KEY exists: ${!!SUPABASE_KEY}`);
    logger.info(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    
    // Check if Supabase is configured
    if (!supabase || !SUPABASE_URL || !SUPABASE_KEY) {
        // In production, we MUST use Supabase Storage
        if (process.env.NODE_ENV === 'production') {
            logger.error('CRITICAL: Production mode but Supabase not configured!');
            throw new Error('Supabase Storage must be configured in production environment');
        }
        
        // Fallback to local storage only in development (if Supabase not configured)
        logger.error('❌ ERROR: Supabase Storage not configured!');
        logger.error('   SUPABASE_URL:', SUPABASE_URL ? 'Set' : 'NOT SET');
        logger.error('   SUPABASE_KEY:', SUPABASE_KEY ? 'Set' : 'NOT SET');
        logger.error('   supabase client:', supabase ? 'Initialized' : 'NOT INITIALIZED');
        logger.error('   Using local storage fallback (development only)');
        logger.error('   Files will be LOST on server restart!');
        logger.error('   To fix: Add SUPABASE_URL and SUPABASE_ANON_KEY to your .env file');
        logger.error('   Get values from: Supabase Dashboard → Settings → API');
        logger.error('   Then RESTART your server!');
        const uniqueName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filePath = path.join(uploadsDir, uniqueName);
        fs.writeFileSync(filePath, file.buffer);
        logger.info(`File saved locally: ${uniqueName}`);
        return uniqueName;
    }
    
    logger.info('✅ Supabase is configured, proceeding with upload...');
    
    try {
        // Optimize image before upload
        let optimizedBuffer = file.buffer;
        const originalSize = file.buffer.length;
        
        try {
            optimizedBuffer = await optimizeImage(file.buffer);
            const optimizedSize = optimizedBuffer.length;
            const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
            logger.info(`Image optimized: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(optimizedSize / 1024 / 1024).toFixed(2)}MB (${savings}% reduction)`);
        } catch (optError) {
            logger.warn('Image optimization failed, using original:', optError.message);
            optimizedBuffer = file.buffer; // Fallback to original
        }
        
        const uniqueName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filePath = `${folder}/${uniqueName}`;
        
        logger.info(`Uploading to Supabase: ${filePath} (${(optimizedBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
        
        const { data, error } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(filePath, optimizedBuffer, {
                contentType: file.mimetype,
                upsert: false
            });
        
        if (error) {
            logger.error('Error uploading to Supabase:', {
                message: error.message,
                statusCode: error.statusCode,
                error: error
            });
            
            // Provide helpful error messages
            if (error.message && error.message.includes('new row violates row-level security policy')) {
                throw new Error('Storage policy error. Check Supabase Storage policies for INSERT permission.');
            } else if (error.message && error.message.includes('Bucket not found')) {
                throw new Error(`Bucket '${STORAGE_BUCKET}' not found. Create it in Supabase Storage.`);
            }
            
            throw error;
        }
        
        // Verify upload succeeded
        if (!data || !data.path) {
            throw new Error('Upload succeeded but no path returned from Supabase');
        }
        
        // Get public URL for verification
        const { data: urlData, error: urlError } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(filePath);
        
        logger.info(`✅ Successfully uploaded to Supabase: ${data.path}`);
        
        if (urlError) {
            logger.error(`⚠️  Warning: Could not generate public URL:`, urlError);
            logger.error(`   This might mean the bucket is not public or SELECT policy is missing.`);
        } else if (urlData?.publicUrl) {
            logger.info(`   Public URL: ${urlData.publicUrl}`);
            // Test if URL is accessible (optional, but helpful for debugging)
            logger.debug(`   Full path in bucket: ${filePath}`);
        } else {
            logger.warn(`   ⚠️  No public URL returned. Check bucket is PUBLIC and SELECT policy exists.`);
        }
        
        return uniqueName; // Return just the filename, we'll construct URL in views
    } catch (error) {
        logger.error('Error in uploadToSupabase:', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// Helper function to get image URL
function getImageUrl(filename) {
    if (!filename) return null;
    
    // If filename is already a full URL or static path, return as-is
    if (typeof filename === 'string') {
        if (filename.startsWith('http://') || filename.startsWith('https://')) {
            return filename;
        }
        if (filename.startsWith('/static/')) {
            return filename;
        }
    }

    if (supabase && SUPABASE_URL) {
        try {
            // Construct the path - filename might already include "uploads/" or might be just the filename
            let filePath = filename;
            
            // If filename doesn't start with "uploads/", add it
            if (!filename.startsWith('uploads/')) {
                filePath = `uploads/${filename}`;
            }
            
            // Use Supabase Storage URL
            const { data, error } = supabase.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(filePath);
            
            if (error) {
                logger.error(`Error getting public URL for ${filename}:`, error);
                logger.error(`   Path used: ${filePath}`);
                logger.error(`   Bucket: ${STORAGE_BUCKET}`);
                // Try manual URL construction as fallback
                if (SUPABASE_URL) {
                    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
                    if (projectRef && projectRef[1]) {
                        const manualUrl = `https://${projectRef[1]}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;
                        logger.info(`Using manual URL construction: ${manualUrl}`);
                        return manualUrl;
                    }
                }
                return `/static/uploads/${filename.replace('uploads/', '')}`;
            }
            
            if (data && data.publicUrl) {
                // Verify the URL is valid
                let url = data.publicUrl;
                
                logger.info(`📸 getImageUrl - Supabase returned URL: ${url}`);
                logger.info(`   Filename: ${filename}`);
                logger.info(`   File path: ${filePath}`);
                logger.info(`   Bucket: ${STORAGE_BUCKET}`);
                
                // Ensure URL is properly formatted and absolute
                if (!url.startsWith('http')) {
                    logger.warn(`⚠️  URL is not absolute, constructing manually`);
                    // If URL is relative, make it absolute
                    if (SUPABASE_URL) {
                        const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
                        if (projectRef && projectRef[1]) {
                            url = `https://${projectRef[1]}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;
                            logger.info(`✅ Constructed URL: ${url}`);
                        } else {
                            url = `${SUPABASE_URL.replace('/rest/v1', '')}/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;
                            logger.info(`✅ Constructed URL (fallback): ${url}`);
                        }
                    }
                }
                
                // Always use manual construction to ensure correct format
                if (SUPABASE_URL) {
                    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
                    if (projectRef && projectRef[1]) {
                        const manualUrl = `https://${projectRef[1]}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;
                        logger.info(`✅ Using manual URL construction: ${manualUrl}`);
                        return manualUrl;
                    }
                }
                
                logger.info(`✅ Final URL: ${url}`);
                return url;
            } else {
                logger.warn(`⚠️  Failed to get public URL for ${filename}, trying manual construction`);
                logger.warn(`   Path used: ${filePath}`);
                logger.warn(`   Data returned:`, JSON.stringify(data));
                // Try manual URL construction
                if (SUPABASE_URL) {
                    const projectRef = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/);
                    if (projectRef && projectRef[1]) {
                        const manualUrl = `https://${projectRef[1]}.supabase.co/storage/v1/object/public/${STORAGE_BUCKET}/${filePath}`;
                        logger.info(`✅ Using manual URL construction (fallback): ${manualUrl}`);
                        return manualUrl;
                    }
                }
                return `/static/uploads/${filename.replace('uploads/', '')}`;
            }
        } catch (error) {
            logger.error(`Error getting image URL for ${filename}:`, error);
            logger.error(`   Error details: ${error.message}`);
            // Fallback to local storage
            return `/static/uploads/${filename.replace('uploads/', '')}`;
        }
    } else {
        // Fallback to local storage (only for development)
        if (process.env.NODE_ENV === 'production') {
            logger.error(`⚠️  CRITICAL: Attempting to use local storage in production for ${filename}.`);
            logger.error(`   Supabase Storage is NOT configured! Photos will be LOST on server restart.`);
            logger.error(`   See PHOTO_FIX_GUIDE.md for setup instructions.`);
        }
        return `/static/uploads/${filename.replace('uploads/', '')}`;
    }
}

// Helper function to delete file from Supabase Storage
async function deleteFromSupabase(filename, folder = 'uploads') {
    if (!supabase) {
        // Fallback to local storage
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return;
    }
    
    try {
        const filePath = `${folder}/${filename}`;
        const { error } = await supabase.storage
            .from(STORAGE_BUCKET)
            .remove([filePath]);
        
        if (error) {
            logger.error('Error deleting from Supabase:', error);
        }
    } catch (error) {
        logger.error('Error in deleteFromSupabase:', error);
    }
}

const app = express();
const PORT = process.env.PORT || 8000;


// Database configuration from environment variables
if (!process.env.DB_HOST && process.env.NODE_ENV === 'production') {
    logger.error('ERROR: DB_HOST environment variable is required in production');
    process.exit(1);
}

// Determine if we're using pooler (production) or direct connection (local)
const isPooler = process.env.DB_HOST && process.env.DB_HOST.includes('pooler');
const isSupabase = process.env.DB_HOST && process.env.DB_HOST.includes('supabase');

// Use pg.Pool for better connection management
const db = new pg.Pool({
    user: process.env.DB_USER || "postgres",
    host: process.env.DB_HOST || "localhost",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "postgres",
    port: parseInt(process.env.DB_PORT) || 5432,
    // ALWAYS enable SSL for Supabase
    ssl: isSupabase 
        ? { rejectUnauthorized: false } 
        : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
    // Force IPv4 connection only for pooler (fixes ENETUNREACH with IPv6)
    family: isPooler ? 4 : undefined,
    // Connection pool settings
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// Test the connection
db.query('SELECT NOW() as current_time')
    .then(result => {
        logger.info('✅ Connected to database successfully');
        logger.info('   Database time:', result.rows[0].current_time);
        logger.info('   Connection type:', isPooler ? 'Pooler' : 'Direct');
    })
    .catch(err => {
        logger.error('❌ Database connection error:', err.message);
        logger.error('   Error code:', err.code);
        logger.error('   Host:', process.env.DB_HOST);
        logger.error('   Port:', process.env.DB_PORT || 5432);
        logger.error('\n   Troubleshooting:');
        logger.error('   1. Verify DB_HOST is: db.xxxxx.supabase.co (not an IP address)');
        logger.error('   2. Check Supabase Network Restrictions (MUST allow all IPs)');
        logger.error('   3. Verify DB_PASSWORD is correct');
        logger.error('   4. Ensure SSL is enabled (should be automatic)');
        process.exit(1);
    });

// ============= SECURITY MIDDLEWARE =============
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:", "http:", "blob:", "*"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com"],
            connectSrc: ["'self'", "*"],
            frameSrc: ["'self'", "https://www.youtube.com", "https://youtube.com"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
}));

// Compression middleware
app.use(compression());

// Rate limiting
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per 15 minutes (increased from 100)
    message: 'Prea multe solicitări din această adresă IP, te rugăm să încerci din nou mai târziu.',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for static files
        return req.path.startsWith('/static/') || 
               req.path.startsWith('/favicon') ||
               req.path === '/health';
    },
    skipSuccessfulRequests: false,
    skipFailedRequests: false,
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 50, // limit uploads to 50 per hour per IP (increased from 20)
    message: 'Prea multe upload-uri. Te rugăm să încerci din nou mai târziu.',
    standardHeaders: true,
    legacyHeaders: false,
});

// Per-user rate limiting (for authenticated users)
const userRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each user to 100 requests per 15 minutes
    message: 'Prea multe solicitări. Te rugăm să încerci din nou mai târziu.',
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use user ID if authenticated, otherwise fall back to IP
        return req.user ? `user_${req.user.id}` : req.ip;
    },
    skip: (req) => {
        // Skip for static files
        return req.path.startsWith('/static/') || 
               req.path.startsWith('/favicon') ||
               req.path === '/health';
    },
});

// Apply rate limiting only to non-static routes
app.use((req, res, next) => {
    // Skip rate limiting for static files
    if (req.path.startsWith('/static/') || 
        req.path.startsWith('/favicon') ||
        req.path === '/health') {
        return next();
    }
    return generalLimiter(req, res, next);
});

// ============= BASIC MIDDLEWARE =============
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// Static files with caching
app.use('/static', express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? '1y' : '0',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
    }
}));

// Service worker (must be served from the origin)
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Serve favicon at standard paths
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.png'));
});
app.get('/favicon.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'favicon.png'));
});

// ============= SESSION SETUP =============
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
    logger.error('ERROR: SESSION_SECRET environment variable is required in production');
    process.exit(1);
}

// Use PostgreSQL session store in production, memory store in development
const sessionConfig = {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS only in production
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
};

// Use PostgreSQL session store if in production and database is available
if (process.env.NODE_ENV === 'production' && process.env.DB_HOST) {
    sessionConfig.store = new pgSession({
        pool: db,
        tableName: 'user_sessions',
        createTableIfMissing: true
    });
    logger.info('Using PostgreSQL session store');
} else {
    logger.info('Using memory session store (development mode)');
}

app.use(session(sessionConfig));

// Flash messages (must be after session)
app.use(flash());

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

// Google OAuth Strategy - Only create if credentials are provided
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.OAUTH_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`
      },
      async function(accessToken, refreshToken, profile, cb) {
        try {
            // Check if user exists in database
            const result = await db.query(
                "SELECT * FROM users WHERE google_id = $1", 
                [profile.id]
            );
            
            if (result.rows.length > 0) {
                // User exists, log them in
                logger.info('OAuth: Existing user found:', result.rows[0].username);
                return cb(null, result.rows[0]);
            } else {
                // New user - they need to create profile
                logger.info('OAuth: New user, google_id:', profile.id);
                return cb(null, { 
                    isNewUser: true, 
                    googleProfile: profile 
                });
            }
        } catch (error) {
            logger.error('OAuth strategy error:', error);
            return cb(error, null);
        }
    }));
    logger.info('✅ Google OAuth configured successfully');
} else {
    logger.warn('⚠️  WARNING: Google OAuth credentials not set. OAuth routes will be disabled.');
}


// Serialize user - save user info to session
passport.serializeUser((user, done) => {
    done(null, user);
});

// Deserialize user - retrieve user info from session
passport.deserializeUser((user, done) => {
    done(null, user);
});

// ============= MIDDLEWARE FUNCTIONS =============

// Middleware to check if user is logged in
function isLoggedIn(req, res, next) {
    // TODO: Check if user is authenticated
    // If yes: call next()
    // If no: redirect to home page

   if (!req.isAuthenticated()) {
        return res.redirect('/');
    }
    else{
        next();
    }
}

// Middleware to check if user has completed profile
function hasProfile(req, res, next) {
    // TODO: Check if req.user has isNewUser property
    // If isNewUser is true: redirect to /create-profile
    // If user has profile: call next()
    if(req.user.isNewUser){
        return res.redirect('/create-profile')
    }
    else{
        next();
    }
}






// ============= AUTHENTICATION ROUTES =============

// Start Google OAuth login
app.get('/auth/google', (req, res) => {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return passport.authenticate('google', { scope: ['profile', 'email'] })(req, res);
    } else {
        return res.status(503).send('Google OAuth is not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.');
    }
});

// Google OAuth callback
app.get('/auth/google/callback', (req, res, next) => {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        passport.authenticate('google', { failureRedirect: '/' })(req, res, function(err) {
            if (err) {
                logger.error('OAuth callback error:', err);
                return res.redirect('/');
            }
            
            // Check if authentication was successful
            if (!req.user) {
                logger.error('OAuth callback: req.user is not set');
                return res.redirect('/');
            }
            
            try {
                // Successful authentication, redirect based on user status
                if (req.user.isNewUser) {
                    logger.info('OAuth callback: New user, redirecting to create-profile');
                    return res.redirect('/create-profile');
                } else if (req.user.username) {
                    logger.info('OAuth callback: Existing user, redirecting to profile:', req.user.username);
                    return res.redirect('/profiles/' + req.user.username);
                } else {
                    logger.error('OAuth callback: User object missing username');
                    return res.redirect('/');
                }
            } catch (error) {
                logger.error('OAuth callback error:', error);
                return res.redirect('/');
            }
        });
    } else {
        return res.redirect('/');
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.logout(function(err) {
        if (err) { 
            logger.error('Logout error:', err);
            return res.redirect('/');
        }
        res.redirect('/');
    });
});

// ============= MAIN PAGES =============

// Home/Landing page
app.get('/', (req, res) => {
    // Always show landing page, regardless of login status
    res.render('landing.ejs', {
        currentUser: req.user || null
    });
});

// Create profile page (for new users)
app.get('/create-profile', isLoggedIn, (req, res) => {
    // TODO: Check if user already has profile (not isNewUser)
    // If has profile: redirect to /explore
    // If new user: render create-profile.ejs with googleProfile data
    if(req.user.isNewUser){
        res.render('create-profile.ejs',{
            googleName: req.user.googleProfile.displayName,
            googleEmail: req.user.googleProfile.emails[0].value,
            errors: [],
            oldInput: {}
        });
    }
    else{
        res.redirect('/explore');
    }
});

// Handle profile creation form submission
app.post('/create-profile', isLoggedIn, [
    body('username')
        .trim()
        .isLength({ min: 3, max: 30 })
        .withMessage('Username-ul trebuie să aibă între 3 și 30 de caractere')
        .matches(/^[a-zA-Z0-9_-]+$/)
        .withMessage('Username-ul poate conține doar litere, cifre, underscore și cratimă')
        .escape(),
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Numele trebuie să aibă între 2 și 100 de caractere')
        .escape(),
    body('city')
        .trim()
        .isLength({ max: 100 })
        .withMessage('Orașul nu poate depăși 100 de caractere')
        .optional()
        .escape()
], async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).render('create-profile.ejs', {
            googleName: req.user.googleProfile.displayName,
            googleEmail: req.user.googleProfile.emails[0].value,
            errors: errors.array(),
            oldInput: req.body
        });
    }

    const username = req.body.username.trim();
    const name = req.body.name.trim();
    const city = req.body.city ? req.body.city.trim() : null;
    const google_id = req.user.googleProfile.id;
    const email = req.user.googleProfile.emails[0].value;
    
    let alrExists = false;

    db.query("SELECT * FROM users WHERE username = $1", [username], (err, result) => {
        if(err){
            logger.error("Database error checking username:", err);
            return res.status(500).render('error', {
                error: 'Eroare',
                message: 'A apărut o eroare. Te rugăm să încerci din nou.',
                currentUser: req.user || null,
                title: 'Eroare'
            });
        }
        
        if(result.rows.length > 0){
            // Username already exists
            return res.status(400).render('create-profile.ejs', {
                googleName: req.user.googleProfile.displayName,
                googleEmail: req.user.googleProfile.emails[0].value,
                errors: [{ msg: 'Username-ul este deja folosit. Te rugăm să alegi altul.' }],
                oldInput: req.body
            });
        }
        else{
            // Username available - insert new user
            const sql = "INSERT INTO users (google_id, username, name, city, email) VALUES ($1, $2, $3, $4, $5) RETURNING *";
            
            db.query(sql, [google_id, username, name, city, email], (err, result) => {
                if (err) {
                    logger.error("Error creating profile:", err);
                    return res.status(500).render('error', {
                        error: 'Eroare',
                        message: 'Nu am putut crea profilul. Te rugăm să încerci din nou.',
                        currentUser: req.user || null,
                        title: 'Eroare'
                    });
                }   
                
                logger.info('Profile created:', { username, userId: result.rows[0].id });
                
                // Update req.user to the new user (remove isNewUser flag)
                req.login(result.rows[0], (err) => {
                    if (err) { 
                        logger.error("Error updating session:", err);
                        return res.status(500).render('error', {
                            error: 'Eroare',
                            message: 'A apărut o eroare la actualizarea sesiunii.',
                            currentUser: req.user || null,
                            title: 'Eroare'
                        });
                    }
                    res.redirect('/explore');
                });
             });
               }
             });
        });

    

// Explore page - shows all user profiles as cards
// Explore page with filtering (now accessible without login)
app.get('/explore', async (req, res) => {
    const selectedRegion = req.query.region || null;
    const selectedGenre = req.query.genre || null;
    const searchQuery = req.query.search || null;

    // Base query
    let sql = "SELECT * FROM users WHERE 1=1";
    let params = [];
    let paramIndex = 1;
    
    // If user is logged in, we'll add them separately, so exclude them from filters
    let currentUserId = null;
    if(req.user && !req.user.isNewUser && req.user.id) {
        currentUserId = req.user.id;
        logger.info(`Current user ID: ${currentUserId}`);
        // Exclude current user from filtered query - we'll add them back first
        sql += ` AND id != $${paramIndex}`;
        params.push(currentUserId);
        paramIndex++;
    }

    // Add Search Filter (searches in name and username)
    if (searchQuery && searchQuery.trim() !== "") {
        sql += ` AND (LOWER(name) LIKE $${paramIndex} OR LOWER(username) LIKE $${paramIndex})`;
        params.push(`%${searchQuery.toLowerCase().trim()}%`);
        paramIndex++;
    }

    // Add Region Filter
    if (selectedRegion && selectedRegion !== "") {
        sql += ` AND $${paramIndex} = ANY(regions)`;
        params.push(selectedRegion);
        paramIndex++;
    }

    // Add Genre Filter
    if (selectedGenre && selectedGenre !== "") {
        sql += ` AND $${paramIndex} = ANY(genres)`;
        params.push(selectedGenre);
        paramIndex++;
    }

    // Fetch current user separately if logged in
    let currentUserPromise = null;
    if(currentUserId) {
        currentUserPromise = new Promise((resolve) => {
            db.query("SELECT * FROM users WHERE id = $1", [currentUserId], (err, result) => {
                if(err || !result.rows.length) {
                    resolve(null);
                } else {
                    resolve(result.rows[0]);
                }
            });
        });
    }

    db.query(sql, params, async (err, result) => {
        if(err){
            console.log("error", err.stack);
            res.status(500).send("Database error");
        }
        else{
            let users = result.rows;
            
            // Get current user (fetched separately to always include them)
            let currentUser = null;
            if(currentUserPromise) {
                currentUser = await currentUserPromise;
                if(currentUser) {
                    logger.info(`✅ Current user fetched: ${currentUser.username} (ID: ${currentUser.id})`);
                }
            }
            
            // Sort other users by profile completeness
            users = users.map(user => {
                let completenessScore = 0;
                
                // Profile picture (20 points)
                if (user.profile_pic) completenessScore += 20;
                
                // Photos (30 points max - 1 point per photo, capped at 30)
                if (user.photos && Array.isArray(user.photos)) {
                    completenessScore += Math.min(user.photos.length, 30);
                }
                
                // YouTube videos (15 points max - 3 points per video, capped at 15)
                if (user.youtube_videos && Array.isArray(user.youtube_videos)) {
                    completenessScore += Math.min(user.youtube_videos.length * 3, 15);
                }
                
                // Description (10 points)
                if (user.description && user.description.trim().length > 0) {
                    completenessScore += 10;
                }
                
                // Services (10 points max - 2 points per service, capped at 10)
                if (user.services && Array.isArray(user.services) && user.services.length > 0) {
                    completenessScore += Math.min(user.services.length * 2, 10);
                }
                
                // Genres (10 points - if has at least one genre)
                if (user.genres && Array.isArray(user.genres) && user.genres.length > 0) {
                    completenessScore += 10;
                }
                
                // Regions (5 points - if has at least one region)
                if (user.regions && Array.isArray(user.regions) && user.regions.length > 0) {
                    completenessScore += 5;
                }
                
                return { ...user, completenessScore: completenessScore };
            });
            
            // Sort by completeness score (highest first), then by name alphabetically
            users.sort((a, b) => {
                if (b.completenessScore !== a.completenessScore) {
                    return b.completenessScore - a.completenessScore;
                }
                return (a.name || '').localeCompare(b.name || '');
            });
            
            // ALWAYS put current user first, regardless of filters or sorting
            if(currentUser) {
                // Make sure current user is not already in the list
                users = users.filter(u => String(u.id) !== String(currentUser.id));
                // Put current user at the very beginning
                users.unshift(currentUser);
                logger.info(`✅ Current user placed at position 0: ${currentUser.username} (ID: ${currentUser.id})`);
            } else if(req.user && !req.user.isNewUser && currentUserId) {
                logger.warn(`⚠️  Current user (ID: ${currentUserId}) could not be fetched`);
            }
            
            // Pagination: show 10 per page
            const page = parseInt(req.query.page) || 1;
            const perPage = 10;
            const startIndex = 0;
            const endIndex = page * perPage;
            const paginatedUsers = (users && Array.isArray(users)) ? users.slice(startIndex, endIndex) : [];
            const hasMore = (users && Array.isArray(users)) ? endIndex < users.length : false;
            const totalUsers = (users && Array.isArray(users)) ? users.length : 0;
            
            // Debug: Log first user
            if(paginatedUsers.length > 0) {
                logger.info(`📋 First user in paginated results: ${paginatedUsers[0].username} (ID: ${paginatedUsers[0].id})`);
                if(req.user && !req.user.isNewUser) {
                    logger.info(`👤 Current logged in user: ${req.user.username} (ID: ${req.user.id})`);
                    if(String(paginatedUsers[0].id) !== String(req.user.id)) {
                        logger.error(`❌ ERROR: Current user is NOT first! First user ID: ${paginatedUsers[0].id}, Current user ID: ${req.user.id}`);
                    } else {
                        logger.info(`✅ SUCCESS: Current user IS first!`);
                    }
                }
            }
            
            res.render('explore.ejs', {
                users: paginatedUsers,
                totalUsers: totalUsers,
                currentPage: page,
                hasMore: hasMore,
                currentUser: req.user || null,
                // Pass data for dropdowns
                allJudete: JUDETE,
                allGenres: GENRES,
                // Pass current selection so dropdowns stay selected
                selectedRegion: selectedRegion,
                selectedGenre: selectedGenre,
                searchQuery: searchQuery,  // Pass search query to keep it in input
                getImageUrl: getImageUrl  // Helper function for image URLs
            });
        }
    });
});

// Individual profile page (now accessible without login)
app.get('/profiles/:username', async (req, res) => {
    const username = req.params.username;
    const cacheKey = `profile_${username}`;
    
    // Check cache first
    const cached = cache.get(cacheKey);
    if (cached && !req.query.refresh) {
        logger.debug(`Cache hit for profile: ${username}`);
        return res.render('profile.ejs', {
            ...cached,
            currentUser: req.user || null, // Always use current user from session
            messages: req.flash()
        });
    }
    
    db.query("SELECT * FROM users WHERE username = $1", [username], (err, result)=>{
        if(err){
            logger.error("Error fetching profile:", err);
            res.status(404).send("User not found");
        }
         else{
            if(result.rows.length > 0){
                // Ensure arrays are initialized if null
                const user = result.rows[0];
                if (!user.photos) user.photos = [];
                if (!user.videos) user.videos = [];
                if (!user.youtube_videos) user.youtube_videos = [];
                if (!user.regions) user.regions = [];
                if (!user.genres) user.genres = [];
                if (!user.services) user.services = [];
                
                // Filter out null, undefined, or empty string photos
                if (Array.isArray(user.photos)) {
                    user.photos = user.photos.filter(photo => photo && photo.trim && photo.trim() !== '' && photo !== null && photo !== undefined);
                } else {
                    logger.warn(`⚠️  Photos is not an array for ${username}, type: ${typeof user.photos}, value:`, user.photos);
                    user.photos = [];
                }
                
                // Log photos for debugging
                logger.info(`📸 Profile photos for ${username}:`, {
                    count: user.photos.length,
                    photos: user.photos,
                    photosType: typeof user.photos,
                    isArray: Array.isArray(user.photos)
                });
                
                // Test image URLs for each photo
                user.photos.forEach((photoName, index) => {
                    const testUrl = getImageUrl(photoName);
                    logger.info(`   Photo ${index + 1}: ${photoName} -> ${testUrl}`);
                });
                // Convert old string array or JSONB to object array if needed
                if (user.services && user.services.length > 0) {
                    if (typeof user.services[0] === 'string') {
                        user.services = user.services.map(s => ({ title: s, details: null }));
                    } else if (typeof user.services === 'object' && !Array.isArray(user.services)) {
                        try {
                            user.services = JSON.parse(user.services);
                        } catch (e) {
                            user.services = [];
                        }
                    }
                }
                
                // Calculate average rating (only ratings >= 3) but count ALL ratings
                db.query(
                    "SELECT AVG(rating) as avg_rating FROM ratings WHERE artist_id = $1 AND rating >= 3",
                    [user.id],
                    (avgErr, avgResult) => {
                        if (avgErr) {
                            logger.error("Error calculating average rating:", avgErr);
                            user.avg_rating = null;
                        } else {
                            user.avg_rating = avgResult.rows[0].avg_rating ? parseFloat(avgResult.rows[0].avg_rating) : null;
                        }
                        
                        // Count ALL ratings (not just >= 3)
                        db.query(
                            "SELECT COUNT(*) as rating_count FROM ratings WHERE artist_id = $1",
                            [user.id],
                            (countErr, countResult) => {
                                if (countErr) {
                                    logger.error("Error calculating rating count:", countErr);
                                    user.rating_count = 0;
                                } else {
                                    user.rating_count = parseInt(countResult.rows[0].rating_count) || 0;
                                }
                                
                                // Fetch reviews (most recent first, limit 20)
                                // Use COALESCE to get reviewer_name from ratings table (for non-logged-in) or users table (for logged-in)
                                db.query(
                                    `SELECT r.*, 
                                            COALESCE(r.reviewer_name, u.name) as reviewer_name, 
                                            u.username as reviewer_username 
                                     FROM ratings r 
                                     LEFT JOIN users u ON r.user_id = u.id 
                                     WHERE r.artist_id = $1 
                                     ORDER BY r.created_at DESC 
                                     LIMIT 20`,
                                    [user.id],
                                    (reviewsErr, reviewsResult) => {
                                        const reviews = reviewsErr ? [] : reviewsResult.rows;
                                        
                                        const profileData = {
                                            profileUser: user,
                                            reviews: reviews,
                                            getImageUrl: getImageUrl
                                        };
                                        
                                        // Cache for 5 minutes
                                        cache.set(cacheKey, profileData, 300);
                                        
                                        res.render('profile.ejs', {
                                            ...profileData,
                                            currentUser: req.user || null,
                                            messages: req.flash()
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            } else {
                res.status(404).send("User not found");
            }
         }
    });
});

// Ruta pentru upload fotografie
app.post('/upload-photo', isLoggedIn, userRateLimiter, uploadLimiter, upload.single('photo'), validateImageFile, async (req, res) => {
    // 1. Verificăm dacă s-a încărcat fișierul
    if (!req.file) {
        req.flash('error', 'Te rog selectează o poză.');
        return res.redirect(`/profiles/${req.user.username}#gallery-section`);
    }

    const userId = req.user.id;

    // 2. Verificăm numărul de poze existente
    db.query("SELECT photos FROM users WHERE id = $1", [userId], async (err, result) => {
        if (err) {
            console.error("Eroare la verificare poze:", err);
            return res.status(500).send('Eroare la baza de date');
        }

        const currentPhotos = result.rows[0].photos || [];
        
        // Limitează la 10 poze
        if (currentPhotos.length >= 10) {
            req.flash('error', 'Ai atins limita de 10 poze. Șterge unele poze înainte de a adăuga altele.');
            return res.redirect(`/profiles/${req.user.username}#gallery-section`);
        }

        try {
            // 3. Upload la Supabase Storage
            logger.info('Starting gallery photo upload for user:', userId);
            const filename = await uploadToSupabase(req.file);
            logger.info('Upload completed, filename:', filename);
            
            // Verify upload was successful
            if (!filename) {
                logger.error('Upload returned empty filename!');
                req.flash('error', 'Eroare: Upload-ul nu a returnat un nume de fișier.');
                return res.redirect(`/profiles/${req.user.username}#gallery-section`);
            }
            
            // 4. Adaugă poza nouă în baza de date
            const sql = "UPDATE users SET photos = COALESCE(array_append(photos, $1), ARRAY[$1]) WHERE id = $2 RETURNING photos";

            db.query(sql, [filename, userId], (err, result) => {
                if (err) {
                    logger.error("Eroare la upload:", err);
                    req.flash('error', 'Eroare la baza de date.');
                    return res.redirect(`/profiles/${req.user.username}#gallery-section`);
                }

                if (!result.rows || result.rows.length === 0) {
                    logger.error("No rows returned after photo upload");
                    req.flash('error', 'Eroare: Nu s-a putut actualiza baza de date.');
                    return res.redirect(`/profiles/${req.user.username}#gallery-section`);
                }

                const updatedPhotos = result.rows[0].photos || [];
                logger.info('✅ Poză adăugată cu succes în baza de date:', { 
                    filename, 
                    userId, 
                    totalPhotos: updatedPhotos.length,
                    allPhotos: updatedPhotos 
                });
                
                // Verify the filename is in the array
                if (!updatedPhotos.includes(filename)) {
                    logger.error(`⚠️  WARNING: Filename ${filename} not found in photos array after upload!`);
                    logger.error(`   Photos array contains:`, updatedPhotos);
                } else {
                    logger.info(`✅ Verified: Filename ${filename} is in photos array`);
                }

                // Clear cache to force refresh
                cache.del(`profile_${req.user.username}`);
                cache.del(`artist_${userId}`);
                // Also clear any explore page cache
                cache.keys().forEach(key => {
                    if (key.startsWith('explore_') || key.startsWith('artist_')) {
                        cache.del(key);
                    }
                });
                req.flash('success', 'Poză adăugată cu succes!');
                // Add cache-busting query parameter to force refresh
                res.redirect(`/profiles/${req.user.username}?refresh=${Date.now()}#gallery-section`);
            });
        } catch (error) {
            logger.error("❌ Eroare la upload la Supabase:", error);
            logger.error("   Error message:", error.message);
            logger.error("   Error stack:", error.stack);
            req.flash('error', 'Eroare la încărcarea pozei. Verifică că Supabase Storage este configurat corect.');
            return res.redirect(`/profiles/${req.user.username}#gallery-section`);
        }
    });
});

app.post('/upload-profile-pic', isLoggedIn, userRateLimiter, uploadLimiter, upload.single('profile_pic'), validateImageFile, async (req, res) => {
    if (!req.file) {
        req.flash('error', 'Te rog selectează o poză.');
        return res.redirect(`/profiles/${req.user.username}#profile-pic-section`);
    }

    const userId = req.user.id;

    try {
        logger.info('Starting profile picture upload for user:', userId);
        logger.info('Supabase configured:', !!supabase);
        logger.info('SUPABASE_URL:', SUPABASE_URL ? 'Set' : 'Not set');
        logger.info('SUPABASE_KEY:', SUPABASE_KEY ? 'Set' : 'Not set');
        
        // Upload to Supabase Storage (or local fallback)
        const filename = await uploadToSupabase(req.file);
        logger.info('Profile pic upload completed, filename:', filename);
        
        if (!filename) {
            logger.error('Upload returned empty filename!');
            req.flash('error', 'Eroare: Upload-ul nu a returnat un nume de fișier.');
            return res.redirect(`/profiles/${req.user.username}#profile-pic-section`);
        }
        
        // Update the profile_pic column specifically
        const sql = "UPDATE users SET profile_pic = $1 WHERE id = $2";

        db.query(sql, [filename, userId], (err, result) => {
            if (err) {
                logger.error("Error uploading profile pic:", err);
                req.flash('error', 'Eroare la baza de date.');
                return res.redirect(`/profiles/${req.user.username}#profile-pic-section`);
            }

            logger.info('✅ Profile picture updated:', { filename, userId });
            // Clear cache
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            req.flash('success', 'Poza de profil a fost actualizată cu succes!');
            res.redirect(`/profiles/${req.user.username}#profile-pic-section`);
        });
    } catch (error) {
        logger.error("❌ Error uploading profile pic to Supabase:", error);
        logger.error("   Error message:", error.message);
        logger.error("   Error stack:", error.stack);
        req.flash('error', 'Eroare la încărcarea pozei de profil. Verifică că Supabase Storage este configurat corect.');
        return res.redirect(`/profiles/${req.user.username}#profile-pic-section`);
    }
});


// ============= DELETE PHOTO ROUTE =============
app.post('/delete-photo', isLoggedIn, async (req, res) => {
    const filename = req.body.filename;
    const userId = req.user.id;

    if (!filename) {
        req.flash('error', 'Numele fișierului lipsește.');
        return res.redirect(`/profiles/${req.user.username}#gallery-section`);
    }

    logger.info(`Attempting to delete photo: ${filename} for user: ${userId}`);

    // 1. Remove photo reference from Database
    // array_remove(column, value) removes the value from the array
    const sql = "UPDATE users SET photos = array_remove(photos, $1) WHERE id = $2 RETURNING photos";

    db.query(sql, [filename, userId], async (err, result) => {
        if (err) {
            logger.error("Error deleting photo from DB:", err);
            req.flash('error', 'Eroare la ștergerea pozei din baza de date.');
            return res.redirect(`/profiles/${req.user.username}#gallery-section`);
        }

        if (!result.rows || result.rows.length === 0) {
            logger.warn(`No user found with ID ${userId}`);
            req.flash('error', 'Utilizatorul nu a fost găsit.');
            return res.redirect(`/profiles/${req.user.username}#gallery-section`);
        }

        logger.info(`Photo removed from DB. Remaining photos: ${result.rows[0].photos ? result.rows[0].photos.length : 0}`);

        // 2. Remove actual file from Supabase Storage
        try {
            await deleteFromSupabase(filename);
            logger.info(`File ${filename} deleted successfully from storage.`);
        } catch (error) {
            // We log the error but don't stop the response, 
            // because it was successfully removed from DB
            logger.error("Error deleting file from storage:", error);
            // Still show success since DB was updated
        }

        // 3. Clear cache to force refresh
        cache.del(`profile_${req.user.username}`);
        cache.del(`artist_${userId}`);
        cache.keys().forEach(key => {
            if (key.startsWith('explore_') || key.startsWith('artist_')) {
                cache.del(key);
            }
        });

        // 4. Redirect back to profile with success message
        req.flash('success', 'Fotografia a fost ștearsă cu succes!');
        res.redirect(`/profiles/${req.user.username}?refresh=${Date.now()}#gallery-section`);
    });
});

// Update Artist Preferences (Regions & Genres)
app.post('/update-preferences', isLoggedIn, (req, res) => {
    const userId = req.user.id;
    
    // Check if only genres or only regions are being updated
    const hasRegions = req.body.regions !== undefined && req.body.regions !== '';
    const hasGenres = req.body.genres !== undefined && req.body.genres !== '';
    
    if (hasRegions && hasGenres) {
        // Both are being updated
        let regions = req.body.regions || [];
        let genres = req.body.genres || [];
        
        if (!Array.isArray(regions)) regions = [regions];
        if (!Array.isArray(genres)) genres = [genres];
        
        const sql = "UPDATE users SET regions = $1, genres = $2 WHERE id = $3";
        db.query(sql, [regions, genres, userId], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send("Error updating preferences");
            }
            // Clear cached profile/explore data so changes are visible immediately
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            // Determine which section to redirect to based on what was updated
            const redirectHash = req.body.regions !== undefined && req.body.regions !== '' ? '#regions-section' : '#genres-section';
            res.redirect(`/profiles/${req.user.username}${redirectHash}`);
        });
    } else if (hasGenres) {
        // Only genres are being updated
        let genres = req.body.genres || [];
        if (!Array.isArray(genres)) genres = [genres];
        
        const sql = "UPDATE users SET genres = $1 WHERE id = $2";
        db.query(sql, [genres, userId], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send("Error updating genres");
            }
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            res.redirect(`/profiles/${req.user.username}#genres-section`);
        });
    } else if (hasRegions) {
        // Only regions are being updated
        let regions = req.body.regions || [];
        if (!Array.isArray(regions)) regions = [regions];
        
        const sql = "UPDATE users SET regions = $1 WHERE id = $2";
        db.query(sql, [regions, userId], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send("Error updating regions");
            }
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            res.redirect(`/profiles/${req.user.username}#regions-section`);
        });
    } else {
        res.redirect(`/profiles/${req.user.username}`);
    }
});

// Update Social Media Links
app.post('/update-social-media', isLoggedIn, (req, res) => {
    // Normalize WhatsApp number (e.g. 0712 345 678 -> +40712 345 678)
    let whatsapp = req.body.whatsapp || null;
    if (whatsapp) {
        // Remove spaces and non-digit/non-plus characters
        let cleaned = whatsapp.replace(/[^0-9+]/g, '');
        // If starts with 0 and looks like a Romanian mobile number, convert to +40...
        if (cleaned.startsWith('0') && cleaned.length >= 10 && !cleaned.startsWith('+40')) {
            cleaned = '+4' + cleaned;
        } else if (!cleaned.startsWith('+') && cleaned.length >= 10) {
            // Fallback: add + if missing
            cleaned = '+' + cleaned;
        }
        whatsapp = cleaned;
    }
    const facebook = req.body.facebook ? req.body.facebook.trim() || null : null;
    const instagram = req.body.instagram ? req.body.instagram.trim() || null : null;
    const tiktok = req.body.tiktok ? req.body.tiktok.trim() || null : null;
    const gmail = req.body.gmail ? req.body.gmail.trim() || null : null;

    const sql = "UPDATE users SET whatsapp = $1, facebook = $2, instagram = $3, tiktok = $4, gmail = $5 WHERE id = $6";
    
    db.query(sql, [whatsapp, facebook, instagram, tiktok, gmail, req.user.id], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send("Error updating social media");
        }
        cache.del(`profile_${req.user.username}`);
        cache.del(`artist_${req.user.id}`);
        res.redirect(`/profiles/${req.user.username}#social-section`);
    });
});

// Helper function to convert YouTube URL to embed format
function convertToYouTubeEmbed(url) {
    if (!url) return null;
    
    // Normalize and handle multiple YouTube URL formats
    url = url.trim();

    let videoId = null;

    try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname;

        // Standard watch URL: https://www.youtube.com/watch?v=VIDEO_ID (also m.youtube.com)
        if ((host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') &&
            path === '/watch') {
            videoId = parsed.searchParams.get('v');
        }

        // Short URL: https://youtu.be/VIDEO_ID
        if (!videoId && (host === 'youtu.be')) {
            videoId = path.split('/')[1] || null;
        }

        // Shorts URL: https://www.youtube.com/shorts/VIDEO_ID
        if (!videoId && (host.endsWith('youtube.com')) && path.startsWith('/shorts/')) {
            videoId = path.split('/')[2] || null;
        }

        // Already embed URL: https://www.youtube.com/embed/VIDEO_ID
        if (!videoId && (host.endsWith('youtube.com')) && path.startsWith('/embed/')) {
            videoId = path.split('/')[2] || null;
        }
    } catch (e) {
        // Fallback to regex parsing if URL constructor fails (e.g. missing protocol)
        const watchMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
        if (watchMatch) {
            videoId = watchMatch[1];
        }
        const shortMatch = url.match(/youtu\.be\/([^&\n?#]+)/);
        if (!videoId && shortMatch) {
            videoId = shortMatch[1];
        }
        const shortsMatch = url.match(/youtube\.com\/shorts\/([^&\n?#]+)/);
        if (!videoId && shortsMatch) {
            videoId = shortsMatch[1];
        }
        const embedMatch = url.match(/youtube\.com\/embed\/([^&\n?#]+)/);
        if (!videoId && embedMatch) {
            videoId = embedMatch[1];
        }
    }

    if (!videoId) {
        return null;
    }

    // Return clean embed URL (without extra params)
    return `https://www.youtube.com/embed/${videoId}`;
}

// Add YouTube Video
app.post('/add-youtube-video', isLoggedIn, (req, res) => {
    const youtubeUrl = req.body.youtube_url;
    const userId = req.user.id;
    
    if (!youtubeUrl) {
        req.flash('error', 'Te rog introdu un link YouTube.');
        return res.redirect(`/profiles/${req.user.username}#youtube-section`);
    }
    
    // Convert to embed format
    const embedUrl = convertToYouTubeEmbed(youtubeUrl);
    
    if (!embedUrl) {
        req.flash('error', 'Link YouTube invalid. Te rog folosește un link complet de pe YouTube (ex: https://www.youtube.com/watch?v=... sau https://youtu.be/...).');
        return res.redirect(`/profiles/${req.user.username}#youtube-section`);
    }
    
    // Check current YouTube videos count
    db.query("SELECT youtube_videos FROM users WHERE id = $1", [userId], (err, result) => {
        if (err) {
            console.error("Eroare la verificare videouri YouTube:", err);
            req.flash('error', 'Eroare la baza de date. Te rugăm să încerci din nou.');
            return res.redirect(`/profiles/${req.user.username}#youtube-section`);
        }
        
        const currentVideos = result.rows[0].youtube_videos || [];
        
        // Check if video already exists
        if (currentVideos.includes(embedUrl)) {
            req.flash('error', 'Acest videoclip YouTube este deja adăugat.');
            return res.redirect(`/profiles/${req.user.username}#youtube-section`);
        }
        
        // Limit to 5 YouTube videos
        if (currentVideos.length >= 5) {
            req.flash('error', 'Ai atins limita de 5 videouri YouTube. Șterge un videoclip înainte de a adăuga altul.');
            return res.redirect(`/profiles/${req.user.username}#youtube-section`);
        }
        
        // Add YouTube video
        const sql = "UPDATE users SET youtube_videos = COALESCE(array_append(youtube_videos, $1), ARRAY[$1]) WHERE id = $2 RETURNING youtube_videos";
        
        db.query(sql, [embedUrl, userId], (err, result) => {
            if (err) {
                console.error("Eroare la adăugare videoclip YouTube:", err);
                return res.status(500).send('Eroare la baza de date');
            }
            
            console.log('Videoclip YouTube adăugat cu succes:', embedUrl);
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            res.redirect(`/profiles/${req.user.username}#youtube-section`);
        });
    });
});

// Delete YouTube Video
app.post('/delete-youtube-video', isLoggedIn, (req, res) => {
    const youtubeUrl = req.body.youtube_url;
    const userId = req.user.id;
    
    if (!youtubeUrl) {
        return res.status(400).send('Link YouTube lipsă.');
    }
    
    // Remove YouTube video from array
    const sql = "UPDATE users SET youtube_videos = array_remove(youtube_videos, $1) WHERE id = $2";
    
    db.query(sql, [youtubeUrl, userId], (err, result) => {
        if (err) {
            console.error("Eroare la ștergere videoclip YouTube:", err);
            return res.status(500).send("Eroare la baza de date");
        }
        
        console.log(`Videoclip YouTube ${youtubeUrl} șters cu succes.`);
        cache.del(`profile_${req.user.username}`);
        cache.del(`artist_${userId}`);
        res.redirect(`/profiles/${req.user.username}#youtube-section`);
    });
});

// Update Description
app.post('/update-description', isLoggedIn, (req, res) => {
    const description = req.body.description || null;
    const userId = req.user.id;
    
        const sql = "UPDATE users SET description = $1 WHERE id = $2";
    
    db.query(sql, [description, userId], (err, result) => {
        if (err) {
            console.error("Error updating description:", err);
            return res.status(500).send("Error updating description");
        }
        cache.del(`profile_${req.user.username}`);
        cache.del(`artist_${userId}`);
        res.redirect(`/profiles/${req.user.username}#description-section`);
    });
});

// Submit Rating with Review Text (can be done by unauthenticated users too)
app.post('/submit-rating', [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating trebuie să fie între 1 și 5'),
    body('review_text').optional().isLength({ max: 1000 }).withMessage('Recenzia nu poate depăși 1000 de caractere').escape(),
    body('reviewer_name').optional().isLength({ min: 1, max: 100 }).withMessage('Numele trebuie să aibă între 1 și 100 de caractere').escape(),
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        req.flash('error', errors.array()[0].msg);
        const artistId = parseInt(req.body.artist_id);
        if (artistId) {
            db.query("SELECT username FROM users WHERE id = $1", [artistId], (err, result) => {
                if (!err && result.rows.length > 0) {
                    return res.redirect(`/profiles/${result.rows[0].username}#rating-section`);
                }
                return res.redirect('/explore');
            });
        } else {
            return res.redirect('/explore');
        }
        return;
    }
    
    const artistId = parseInt(req.body.artist_id);
    const rating = parseInt(req.body.rating);
    const reviewText = req.body.review_text ? req.body.review_text.trim() : null;
    const reviewerName = req.body.reviewer_name ? req.body.reviewer_name.trim() : null;
    const userId = req.user ? req.user.id : null;
    const userIp = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (!artistId || !rating || rating < 1 || rating > 5) {
        req.flash('error', 'Rating invalid.');
        return res.redirect('/explore');
    }
    
    // Require reviewer_name for non-logged-in users
    if (!userId && (!reviewerName || reviewerName.trim() === '')) {
        req.flash('error', 'Numele este obligatoriu pentru a lăsa o evaluare.');
        db.query("SELECT username FROM users WHERE id = $1", [artistId], (err, result) => {
            if (!err && result.rows.length > 0) {
                return res.redirect(`/profiles/${result.rows[0].username}#rating-section`);
            }
            return res.redirect('/explore');
        });
        return;
    }
    
    if (userId && artistId === userId) {
        req.flash('error', 'Nu poți evalua propriul profil.');
        return res.redirect('/explore');
    }
    
    // Check if user already rated this artist (by user_id or by IP if not logged in)
    const checkQuery = userId 
        ? "SELECT * FROM ratings WHERE user_id = $1 AND artist_id = $2"
        : "SELECT * FROM ratings WHERE user_ip = $1 AND artist_id = $2 AND user_id IS NULL";
    const checkParams = userId ? [userId, artistId] : [userIp, artistId];
    
    db.query(checkQuery, checkParams, (err, result) => {
        if (err) {
            logger.error("Error checking existing rating:", err);
            req.flash('error', 'Eroare la baza de date.');
            return res.redirect('/explore');
        }
        
        if (result.rows.length > 0) {
            // Update existing rating
            const updateQuery = userId
                ? "UPDATE ratings SET rating = $1, review_text = $2, reviewer_name = $3, updated_at = NOW() WHERE user_id = $4 AND artist_id = $5"
                : "UPDATE ratings SET rating = $1, review_text = $2, reviewer_name = $3, updated_at = NOW() WHERE user_ip = $4 AND artist_id = $5 AND user_id IS NULL";
            const updateParams = userId ? [rating, reviewText, reviewerName, userId, artistId] : [rating, reviewText, reviewerName, userIp, artistId];
            
            db.query(updateQuery, updateParams, (updateErr) => {
                if (updateErr) {
                    logger.error("Error updating rating:", updateErr);
                    req.flash('error', 'Eroare la actualizarea evaluării.');
                } else {
                    req.flash('success', 'Evaluarea a fost actualizată cu succes!');
                }
                // Get username for redirect and clear cache
                db.query("SELECT username FROM users WHERE id = $1", [artistId], (userErr, userResult) => {
                    if (userErr || userResult.rows.length === 0) {
                        return res.redirect('/explore');
                    }
                    const username = userResult.rows[0].username;
                    // Clear profile cache using username
                    cache.del(`profile_${username}`);
                    cache.del(`artist_${artistId}`);
                    res.redirect(`/profiles/${username}#rating-section`);
                });
            });
        } else {
            // Insert new rating
            const insertQuery = userId
                ? "INSERT INTO ratings (user_id, artist_id, rating, review_text, reviewer_name) VALUES ($1, $2, $3, $4, $5)"
                : "INSERT INTO ratings (user_ip, artist_id, rating, review_text, reviewer_name) VALUES ($1, $2, $3, $4, $5)";
            const insertParams = userId ? [userId, artistId, rating, reviewText, reviewerName] : [userIp, artistId, rating, reviewText, reviewerName];
            
            db.query(insertQuery, insertParams, (insertErr) => {
                if (insertErr) {
                    logger.error("Error inserting rating:", insertErr);
                    req.flash('error', 'Eroare la salvarea evaluării.');
                } else {
                    req.flash('success', 'Evaluarea a fost trimisă cu succes!');
                }
                // Get username for redirect and clear cache
                db.query("SELECT username FROM users WHERE id = $1", [artistId], (userErr, userResult) => {
                    if (userErr || userResult.rows.length === 0) {
                        return res.redirect('/explore');
                    }
                    const username = userResult.rows[0].username;
                    // Clear profile cache using username
                    cache.del(`profile_${username}`);
                    cache.del(`artist_${artistId}`);
                    res.redirect(`/profiles/${username}#rating-section`);
                });
            });
        }
    });
});

// Add Service
app.post('/add-service', isLoggedIn, (req, res) => {
    const serviceTitle = req.body.service_title.trim();
    const serviceDetails = req.body.service_details ? req.body.service_details.trim() : null;
    const userId = req.user.id;
    
    if (!serviceTitle) {
        return res.status(400).send('Te rog introdu un nume de serviciu.');
    }
    
    // Create service object
    const serviceObj = {
        title: serviceTitle,
        details: serviceDetails || null
    };
    
    // Check current services and handle conversion
    db.query("SELECT services, pg_typeof(services) as services_type FROM users WHERE id = $1", [userId], (err, result) => {
        if (err) {
            console.error("Error checking services:", err);
            return res.status(500).send('Database error');
        }
        
        let currentServices = [];
        const servicesData = result.rows[0].services;
        const servicesType = result.rows[0].services_type;
        
        // Handle different data types
        if (!servicesData) {
            currentServices = [];
        } else if (servicesType === 'text[]' || Array.isArray(servicesData)) {
            // Convert text array to JSONB array
            if (typeof servicesData[0] === 'string') {
                currentServices = servicesData.map(s => ({ title: s, details: null }));
            } else {
                currentServices = servicesData;
            }
        } else if (typeof servicesData === 'object') {
            // Already JSONB
            try {
                currentServices = Array.isArray(servicesData) ? servicesData : JSON.parse(servicesData);
            } catch (e) {
                currentServices = [];
            }
        }
        
        // Check if service with same title already exists
        const serviceExists = currentServices.some(s => {
            if (typeof s === 'string') {
                return s === serviceTitle;
            }
            return s && s.title === serviceTitle;
        });
        
        if (serviceExists) {
            return res.status(400).send('Acest serviciu este deja adăugat.');
        }
        
        // Add new service to array
        currentServices.push(serviceObj);
        
        // Update with JSONB
        const sql = "UPDATE users SET services = $1::jsonb WHERE id = $2 RETURNING services";
        
        db.query(sql, [JSON.stringify(currentServices), userId], (err, result) => {
            if (err) {
                console.error("Error adding service:", err);
                return res.status(500).send('Database error');
            }
            
            console.log('Serviciu adăugat cu succes:', serviceTitle);
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            res.redirect(`/profiles/${req.user.username}#services-section`);
        });
    });
});

// Delete Service
app.post('/delete-service', isLoggedIn, (req, res) => {
    const serviceTitle = req.body.service_title;
    const userId = req.user.id;
    
    if (!serviceTitle) {
        return res.status(400).send('Serviciu lipsă.');
    }
    
    // Get current services and handle conversion
    db.query("SELECT services, pg_typeof(services) as services_type FROM users WHERE id = $1", [userId], (err, result) => {
        if (err) {
            console.error("Error getting services:", err);
            return res.status(500).send("Database error");
        }
        
        let currentServices = [];
        const servicesData = result.rows[0].services;
        const servicesType = result.rows[0].services_type;
        
        // Handle different data types
        if (!servicesData) {
            currentServices = [];
        } else if (servicesType === 'text[]' || Array.isArray(servicesData)) {
            // Convert text array to JSONB array
            if (typeof servicesData[0] === 'string') {
                currentServices = servicesData.map(s => ({ title: s, details: null }));
            } else {
                currentServices = servicesData;
            }
        } else if (typeof servicesData === 'object') {
            // Already JSONB
            try {
                currentServices = Array.isArray(servicesData) ? servicesData : JSON.parse(servicesData);
            } catch (e) {
                currentServices = [];
            }
        }
        
        // Remove service
        currentServices = currentServices.filter(s => {
            if (typeof s === 'string') {
                return s !== serviceTitle;
            }
            return s && s.title !== serviceTitle;
        });
        
        // Update with JSONB
        const sql = "UPDATE users SET services = $1::jsonb WHERE id = $2";
        
        db.query(sql, [JSON.stringify(currentServices), userId], (err, result) => {
            if (err) {
                console.error("Error deleting service:", err);
                return res.status(500).send("Database error");
            }
            
            console.log(`Serviciu ${serviceTitle} șters cu succes.`);
            cache.del(`profile_${req.user.username}`);
            cache.del(`artist_${userId}`);
            res.redirect(`/profiles/${req.user.username}#services-section`);
        });
    });
});


// Legal Pages
app.get('/legal/terms', (req, res) => {
    res.render('legal-terms.ejs');
});

app.get('/legal/privacy', (req, res) => {
    res.render('legal-privacy.ejs');
});

app.get('/legal/cookies', (req, res) => {
    res.render('legal-cookies.ejs');
});

// ============= HEALTH CHECK =============
app.get('/health', (req, res) => {
    db.query('SELECT 1 as health', (err) => {
        if (err) {
            logger.error('Health check failed:', err);
            return res.status(503).json({ 
                status: 'unhealthy', 
                db: 'disconnected',
                supabase: supabase ? 'configured' : 'not configured',
                timestamp: new Date().toISOString()
            });
        }
        res.json({ 
            status: 'healthy', 
            db: 'connected',
            supabase: supabase ? 'configured' : 'not configured',
            storage: supabase ? 'Supabase Storage' : (process.env.NODE_ENV === 'production' ? 'LOCAL (PHOTOS WILL BE LOST!)' : 'Local (dev)'),
            timestamp: new Date().toISOString()
        });
    });
});

// ============= ERROR HANDLING =============
// 404 Handler
app.use((req, res, next) => {
    res.status(404).render('error', {
        error: 'Pagina nu a fost găsită',
        message: 'Pagina pe care o cauți nu există.',
        currentUser: req.user || null,
        title: '404 - Pagină negăsită'
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
    logger.error('Error:', {
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        userId: req.user ? req.user.id : null
    });

    // Don't leak error details in production
    const message = process.env.NODE_ENV === 'production' 
        ? 'A apărut o eroare. Te rugăm să încerci din nou mai târziu.' 
        : err.message;

    res.status(err.status || 500).render('error', {
        error: 'Eroare',
        message: message,
        currentUser: req.user || null,
        title: 'Eroare'
    });
});

// ============= STARTUP DIAGNOSTICS =============
// Check Supabase Storage configuration
if (process.env.NODE_ENV === 'production') {
    logger.info('\n=== PRODUCTION ENVIRONMENT CHECK ===');
    
    if (!SUPABASE_URL) {
        logger.error('❌ SUPABASE_URL environment variable is NOT set in Render!');
        logger.error('   Photos will be lost on server restart.');
        logger.error('   Please add SUPABASE_URL to Render environment variables.');
    } else {
        logger.info('✅ SUPABASE_URL is set');
    }
    
    if (!SUPABASE_KEY) {
        logger.error('❌ SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY is NOT set in Render!');
        logger.error('   Photos will be lost on server restart.');
        logger.error('   Please add SUPABASE_ANON_KEY to Render environment variables.');
    } else {
        logger.info('✅ SUPABASE_KEY is set');
    }
    
    if (supabase) {
        logger.info('✅ Supabase Storage is properly configured');
        logger.info('   Photos will be stored persistently in Supabase Storage');
    } else {
        logger.error('❌ CRITICAL: Supabase Storage is NOT configured in production!');
        logger.error('   Photos uploaded will be lost when server restarts.');
        logger.error('   Steps to fix:');
        logger.error('   1. Go to Render Dashboard → Your Service → Environment');
        logger.error('   2. Add SUPABASE_URL=https://your-project.supabase.co');
        logger.error('   3. Add SUPABASE_ANON_KEY=your-anon-key-here');
        logger.error('   4. Get keys from Supabase Dashboard → Settings → API');
        logger.error('   5. Create a public bucket named "uploads" in Supabase Storage');
        logger.error('   6. Redeploy your service');
        logger.error('\n');
    }
    
    logger.info('====================================\n');
}

// ============= START SERVER =============
const server = app.listen(PORT, () => {
    logger.info(`✅ Server started on port ${PORT}`);
    logger.info(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.NODE_ENV !== 'production') {
        logger.info(`   URL: http://localhost:${PORT}`);
    }
    
    if (supabase) {
        logger.info('   Storage: Supabase Storage ✅');
    } else if (process.env.NODE_ENV === 'production') {
        logger.warn('   Storage: Local (PHOTOS WILL BE LOST ON RESTART!) ⚠️');
    } else {
        logger.info('   Storage: Local (development)');
    }
});

// Graceful Shutdown
const gracefulShutdown = (signal) => {
    logger.info(`${signal} received, closing server gracefully...`);
    
    server.close(() => {
        logger.info('HTTP server closed');
        
        // Close database pool
        db.end(() => {
            logger.info('Database connections closed');
            process.exit(0);
        });
    });
    
    // Force close after 10 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

