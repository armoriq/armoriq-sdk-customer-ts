#!/bin/bash

# ArmorIQ TypeScript SDK - Installation Script
# This script sets up the SDK for development or usage

set -e

echo "🚀 ArmorIQ TypeScript SDK - Installation"
echo "========================================"
echo ""

# Check Node.js version
echo "📦 Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Error: Node.js 18 or higher is required"
    echo "   Current version: $(node -v)"
    exit 1
fi
echo "✅ Node.js version: $(node -v)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install
echo "✅ Dependencies installed"
echo ""

# Build the SDK
echo "🔨 Building TypeScript SDK..."
npm run build
echo "✅ SDK built successfully"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📝 Creating .env file from template..."
    cp .env.example .env
    echo "✅ .env file created"
    echo ""
    echo "⚠️  IMPORTANT: Edit .env file and add your API key!"
    echo "   Get your API key from: https://platform.armoriq.ai/dashboard/api-keys"
    echo ""
else
    echo "✅ .env file already exists"
    echo ""
fi

# Check if API key is set
if [ -f .env ]; then
    if grep -q "ak_test_your_key_here" .env || grep -q "ak_live_your_key_here" .env; then
        echo "⚠️  WARNING: Default API key detected in .env"
        echo "   Please update with your actual API key from platform.armoriq.ai"
        echo ""
    fi
fi

echo "✅ Installation complete!"
echo ""
echo "📚 Next steps:"
echo "   1. Edit .env file with your API key"
echo "   2. Run example: npx ts-node examples/quickstart.ts"
echo "   3. Read documentation: cat README.md"
echo ""
echo "🔗 Resources:"
echo "   - Platform: https://platform.armoriq.ai"
echo "   - Docs: https://docs.armoriq.ai"
echo "   - Support: license@armoriq.io"
echo ""
echo "Happy coding! 🎉"
