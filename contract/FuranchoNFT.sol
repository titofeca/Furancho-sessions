// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FuranchoNFT is ERC1155, Ownable {
    // Token IDs: 0=Cautivo, 1=O Cunqueiro, 2=O Larpeiro, 3=O Presidente
    string public name = "Furancho Sessions";

    // Wallet del servidor (minter) — puede ser distinta al owner
    address public minter;

    modifier onlyMinter() {
        require(msg.sender == minter || msg.sender == owner(), "No autorizado");
        _;
    }

    constructor(string memory baseURI, address _minter)
        ERC1155(baseURI)
        Ownable(msg.sender)
    {
        minter = _minter;
    }

    // El servidor llama a esta función para cada NFT
    function mint(address to, uint256 tokenId, uint256 amount) external onlyMinter {
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
}
