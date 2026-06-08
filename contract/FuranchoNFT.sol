// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FuranchoNFT is ERC1155, Ownable {
    // Token IDs: 1=O Cautivo, 2=O Cunqueiro, 3=O Larpeiro, 4=O Presidente
    string public name = "Furancho Sessions";

    // Wallet del servidor (minter) — puede ser distinta al owner
    address public minter;

    // Pausa de emergencia
    bool public paused = false;

    // Evitar doble mint por nivel: wallet => tokenId => bool
    mapping(address => mapping(uint256 => bool)) public hasClaimed;

    modifier onlyMinter() {
        require(msg.sender == minter || msg.sender == owner(), "No autorizado");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contrato pausado");
        _;
    }

    constructor(string memory baseURI, address _minter)
        ERC1155(baseURI)
        Ownable(msg.sender)
    {
        minter = _minter;
    }

    // El servidor llama a esta función para cada NFT
    function mint(address to, uint256 tokenId, uint256 amount) external onlyMinter whenNotPaused {
        require(!hasClaimed[to][tokenId], "Ya tiene este nivel");
        hasClaimed[to][tokenId] = true;
        _mint(to, tokenId, amount, "");
    }

    // Cambiar wallet minter si hace falta
    function setMinter(address _minter) external onlyOwner {
        minter = _minter;
    }

    // Cambiar URI base (para actualizar metadatos)
    function setURI(string memory newURI) external onlyOwner {
        _setURI(newURI);
    }

    // Pausa de emergencia — detiene todos los mints
    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }
}
